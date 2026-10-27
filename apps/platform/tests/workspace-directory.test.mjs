import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceDirectory,DirectoryError} from '../server/workspace-directory.mjs';
import {fixtureConfig} from './helpers/mail-fixtures.mjs';

const alice={union_id:'on_fictional_alice01',name:'虚构甲',enterprise_email:'alice@110-lab.cn'};
const bob={union_id:'on_fictional_bob0002',name:'虚构乙',email:'personal@example.org'};
const response=data=>new Response(JSON.stringify({code:0,data}));
function fake(){
  const calls=[];let fail=false;
  return {calls,setFail(){fail=true;},async fetch(url,options){
    const u=new URL(url);calls.push({path:u.pathname,query:u.searchParams,options});
    assert.equal(u.origin,'https://open.feishu.cn');assert.equal(options.redirect,'error');
    if(fail)throw new Error('private upstream detail');
    if(u.pathname.endsWith('/internal'))return new Response(JSON.stringify({code:0,tenant_access_token:'test-only',expire:7200}));
    assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer test-only');
    if(u.pathname.endsWith('/children'))return response({items:[{open_department_id:'od-fictional'}],has_more:false});
    assert.equal(u.searchParams.get('user_id_type'),'union_id');
    if(u.searchParams.get('department_id')==='0')return response({items:[alice],has_more:false});
    if(u.searchParams.get('page_token'))return response({items:[{...alice,status:{is_resigned:true}}],has_more:false});
    return response({items:[alice,bob],has_more:true,page_token:'page2'});
  }};
}
test('project directory uses tenant union identities, paginates, deduplicates and never fabricates email',async()=>{
  const provider=fake();let now=1000;const d=createWorkspaceDirectory({config:fixtureConfig,fetchImpl:provider.fetch,now:()=>now});
  const [members,concurrent]=await Promise.all([d.list(),d.list()]);assert.deepEqual(members,concurrent);
  assert.equal(members.length,2);assert.equal(members.find(m=>m.name==='虚构乙').email,'');
  assert.equal(members[0].subject.split(':')[0],fixtureConfig.tenantKey);
  assert.equal(provider.calls.filter(c=>c.path.endsWith('/internal')).length,1);
  const n=provider.calls.length;await d.list();assert.equal(provider.calls.length,n);
  now+=61000;provider.setFail();await assert.rejects(d.list(),DirectoryError);
  const failures=provider.calls.length;await assert.rejects(d.list(),DirectoryError);assert.equal(provider.calls.length,failures);
});
test('directory fails closed on repeated pagination token, malformed identifiers and oversized body',async()=>{
  for(const mode of ['loop','invalid','oversize','denied']){
    const d=createWorkspaceDirectory({config:fixtureConfig,fetchImpl:async url=>{
      if(url.endsWith('/internal'))return new Response(JSON.stringify({code:0,tenant_access_token:'test',expire:7200}));
      if(mode==='oversize')return new Response('x'.repeat(512*1024+1));
      if(mode==='denied')return new Response(JSON.stringify({code:99991672,msg:'private diagnostic'}));
      if(mode==='loop')return response({items:[],has_more:true,page_token:'repeat'});
      if(url.includes('/children'))return response({items:[],has_more:false});
      return response({items:[{...alice,union_id:'foreign:subject'}],has_more:false});
    }});
    await assert.rejects(d.list(),e=>e instanceof DirectoryError&&!e.message.includes('private'));
  }
});

test('sensitive grants can bypass the directory cache',async()=>{
  const provider=fake(),directory=createWorkspaceDirectory({config:fixtureConfig,fetchImpl:provider.fetch});
  await directory.list();const before=provider.calls.length;
  await directory.list();assert.equal(provider.calls.length,before);
  provider.setFail();await assert.rejects(directory.list({fresh:true}),DirectoryError);
});

const active={is_resigned:false,is_exited:false,is_frozen:false,is_activated:true};
test('permission snapshot includes nested departments, rejects departed duplicate users and uses immutable open IDs',async()=>{
 const users={...alice,status:active},child={...bob,status:active};
 const d=createWorkspaceDirectory({config:fixtureConfig,fetchImpl:async url=>{
  if(url.endsWith('/internal'))return new Response(JSON.stringify({code:0,tenant_access_token:'test',expire:7200}));
  if(url.includes('/children'))return response({items:[{open_department_id:'od-parent',parent_department_id:'0',name:'研发'},{open_department_id:'od-child',parent_department_id:'od-parent',name:'前端'}],has_more:false});
  const id=new URL(url).searchParams.get('department_id');return response({items:id==='od-child'?[child]:id==='0'?[users]:[],has_more:false});
 }});
 const s=await d.snapshot();assert.equal(s.departments.find(g=>g.id==='od-child').path,'研发 / 前端');assert.deepEqual(s.departments.find(g=>g.id==='od-parent').subjects,[fixtureConfig.tenantKey+':'+bob.union_id]);assert.equal(s.members.length,2);
});
test('partial permission fields or cyclic department snapshots cannot be published as an access snapshot',async()=>{
 const partial=fake(),d=createWorkspaceDirectory({config:fixtureConfig,fetchImpl:partial.fetch});assert.equal((await d.list()).length,2);await assert.rejects(d.snapshot(),DirectoryError);
 for(const mode of ['cycle','missing-status','duplicate']){
  const rows=mode==='duplicate'?[{open_department_id:'od-a',name:'甲',parent_department_id:'0'},{open_department_id:'od-a',name:'乙',parent_department_id:'0'}]:[{open_department_id:'od-a',name:'甲',parent_department_id:mode==='cycle'?'od-a':'0'}];
  const v=createWorkspaceDirectory({config:fixtureConfig,fetchImpl:async url=>url.endsWith('/internal')?new Response(JSON.stringify({code:0,tenant_access_token:'t',expire:7200})):response({items:url.includes('/children')?rows:[{...alice,...(mode==='missing-status'?{}:{status:active})}],has_more:false})});await assert.rejects(v.snapshot(),DirectoryError);
 }
});
test('an inactive duplicate observation cannot retain a personal or department membership',async()=>{
 const d=createWorkspaceDirectory({config:fixtureConfig,fetchImpl:async url=>url.endsWith('/internal')?new Response(JSON.stringify({code:0,tenant_access_token:'t',expire:7200})):response({items:url.includes('/children')?[{open_department_id:'od-a',name:'甲',parent_department_id:'0'}]:[{...alice,status:{...active,is_frozen:new URL(url).searchParams.get('department_id')==='od-a'}}],has_more:false})});
 const s=await d.snapshot();assert.equal(s.members.length,0);assert.deepEqual(s.departments[0].subjects,[]);
});
