import test from 'node:test';
import assert from 'node:assert/strict';
import {createFavoritesClient} from '../src/workbench-favorites.js';
import {matchesApp,appIcon,safeAppUrl} from '../src/workbench-catalog.js';
const a={subject:'fixture:a',csrf:'a'}, b={subject:'fixture:b',csrf:'b'};
const error=status=>Object.assign(new Error('test failure'),{status});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};};

test('late reads and writes cannot resurrect favorites after logout or identity switch',async()=>{
  const gate=deferred();let delayed=false;
  const client=createFavoritesClient({request:async(method,_body,actor)=>actor.subject===a.subject?delayed?gate.promise:{subject:a.subject,revision:1,favoriteAppIds:['knowledge']}:{subject:b.subject,revision:0,favoriteAppIds:[]}});
  await client.setIdentity(a);delayed=true;const pending=client.setFavorite('projects',true);await Promise.resolve();
  await client.setIdentity(b);gate.resolve({subject:a.subject,revision:2,favoriteAppIds:['knowledge','projects']});await pending;
  assert.equal(client.snapshot().subject,b.subject);assert.deepEqual(client.snapshot().favoriteAppIds,[]);
  const readGate=deferred();const reader=createFavoritesClient({request:()=>readGate.promise});const read=reader.setIdentity(a);await Promise.resolve();await reader.setIdentity(null);readGate.resolve({subject:a.subject,revision:10,favoriteAppIds:['public-mail']});await read;assert.deepEqual(reader.snapshot().favoriteAppIds,[]);assert.equal(reader.snapshot().ready,false);
});
test('conflicting windows rebase the one add/remove intent without losing another favorite',async()=>{
  let value={subject:a.subject,revision:1,favoriteAppIds:['knowledge']},conflict=true;const bodies=[];
  const client=createFavoritesClient({request:async(method,body)=>{if(method==='GET')return structuredClone(value);bodies.push(body);if(conflict){conflict=false;value={subject:a.subject,revision:2,favoriteAppIds:['knowledge','public-mail']};throw error(409);}assert.equal(body.revision,2);value={subject:a.subject,revision:3,favoriteAppIds:body.favoriteAppIds};return value;}});
  await client.setIdentity(a);await client.setFavorite('projects',true);
  assert.deepEqual(client.snapshot().favoriteAppIds,['knowledge','public-mail','projects']);assert.equal(bodies.length,2);
});
test('unknown POST outcome reconciles committed changes without duplicate writes or false success',async()=>{
  let value={subject:a.subject,revision:0,favoriteAppIds:[]},writes=0,commit=true;
  const client=createFavoritesClient({request:async(method,body)=>{if(method==='GET')return value;writes++;if(commit)value={subject:a.subject,revision:1,favoriteAppIds:body.favoriteAppIds};throw new Error('network disconnected');}});
  await client.setIdentity(a);await client.setFavorite('projects',true);assert.equal(writes,1);assert.equal(client.snapshot().error,'');
  commit=false;await client.setFavorite('knowledge',true);assert.equal(writes,2);assert.equal(client.snapshot().favoriteAppIds.includes('knowledge'),false);assert.match(client.snapshot().error,/暂时无法连接收藏服务/);
});
test('queued intents serialize, stale revision loop is bounded, and authorization loss clears private state',async()=>{
  let value={subject:a.subject,revision:0,favoriteAppIds:[]},reject=false,denied=false,writes=0,expired=0;
  const client=createFavoritesClient({onUnauthorized:()=>expired++,request:async(method,body)=>{if(denied)throw error(401);if(method==='GET')return value;writes++;if(reject)throw error(409);value={subject:a.subject,revision:value.revision+1,favoriteAppIds:body.favoriteAppIds};return value;}});
  await client.setIdentity(a);await Promise.all([client.setFavorite('projects',true),client.setFavorite('knowledge',true)]);assert.deepEqual(value.favoriteAppIds,['projects','knowledge']);reject=true;const before=writes;await client.setFavorite('assessment',true);assert.equal(writes-before,3);assert.match(client.snapshot().error,/其他页面/);
  denied=true;await client.refresh();assert.equal(expired,1);assert.equal(client.snapshot().subject,null);assert.deepEqual(client.snapshot().favoriteAppIds,[]);
});
test('search finds approved and original app names and destinations and icons remain constrained',()=>{
  const app={id:'recruitment-test',title:'招新管理',description:'面试安排',url:'https://internal.110-lab.cn/recruitment',icon:'recruitment'};
  assert.equal(matchesApp(app,'HiFlow'),true);assert.equal(matchesApp(app,'招新'),true);assert.equal(appIcon(app),'/assets/cobuild/hiflow.png');
  assert.equal(safeAppUrl('javascript:alert(1)'), '');assert.equal(safeAppUrl('https://user:pw@example.org'),'');assert.equal(safeAppUrl(app.url),app.url);
  assert.equal(appIcon({id:'custom',icon:'../../secret',iconUrl:'https://evil.example/tracker'}),'/assets/icons/apps.svg');
});
test('same-user credential rotation cancels queued old writes and preserves the new authenticated state',async()=>{
  const gate=deferred();let blocked=false;const posts=[],unauthorized=[];
  const client=createFavoritesClient({onUnauthorized:e=>unauthorized.push(e),request:async(method,body,actor)=>{if(method==='POST'){posts.push(actor.csrf);if(actor.csrf==='a')throw error(403);return {subject:a.subject,revision:2,favoriteAppIds:body.favoriteAppIds};}if(blocked&&actor.csrf==='a')return gate.promise;return {subject:a.subject,revision:1,favoriteAppIds:['knowledge']};}});
  await client.setIdentity(a);blocked=true;const read=client.refresh();await Promise.resolve();const write=client.setFavorite('projects',true);
  await client.setIdentity({...a,csrf:'new-csrf'});gate.resolve({subject:a.subject,revision:1,favoriteAppIds:['knowledge']});await Promise.all([read,write]);
  assert.deepEqual(posts,[]);assert.equal(unauthorized.length,0);assert.equal(client.snapshot().subject,a.subject);
  await client.setFavorite('projects',true);assert.deepEqual(posts,['new-csrf']);
});
test('server-authenticated subject mismatch never attaches another account favorites to a stale profile',async()=>{
  let switched=false,expired=0;const client=createFavoritesClient({onUnauthorized:()=>expired++,request:async()=>({subject:switched?b.subject:a.subject,revision:1,favoriteAppIds:switched?['public-mail']:['knowledge']})});
  await client.setIdentity(a);switched=true;await client.refresh();assert.equal(expired,1);assert.equal(client.snapshot().subject,null);assert.deepEqual(client.snapshot().favoriteAppIds,[]);
});
test('same-user session polling recovers from an initial network failure without a reload',async()=>{
  let failed=true;const client=createFavoritesClient({request:async()=>{if(failed)throw new Error('offline');return {subject:a.subject,revision:0,favoriteAppIds:[]};}});
  await client.setIdentity(a);assert.equal(client.snapshot().ready,false);failed=false;await client.setIdentity({...a});assert.equal(client.snapshot().ready,true);assert.equal(client.snapshot().error,'');
});

test('timeouts keep known favorites and identity, and an explicit retry recovers',async()=>{
  let failure=null;const client=createFavoritesClient({request:async()=>{if(failure)throw failure;return {subject:a.subject,revision:2,favoriteAppIds:['knowledge']};}});
  await client.setIdentity(a);
  for(const name of ['TimeoutError','AbortError']){
    failure=Object.assign(new Error('signal timed out'),{name});await client.refresh();
    assert.equal(client.snapshot().error,'收藏加载超时，请重试');assert.equal(client.snapshot().pending,false);
    assert.equal(client.snapshot().subject,a.subject);assert.deepEqual(client.snapshot().favoriteAppIds,['knowledge']);
  }
  failure=null;await client.refresh();assert.equal(client.snapshot().error,'');
});
test('an initial timeout remains a failed load until retry succeeds',async()=>{
  let fail=true;const client=createFavoritesClient({request:async()=>{if(fail)throw Object.assign(new Error('signal timed out'),{name:'TimeoutError'});return {subject:a.subject,revision:0,favoriteAppIds:[]};}});
  await client.setIdentity(a);assert.equal(client.snapshot().ready,false);assert.match(client.snapshot().error,/超时/);
  fail=false;await client.refresh();assert.equal(client.snapshot().ready,true);assert.equal(client.snapshot().error,'');
});
