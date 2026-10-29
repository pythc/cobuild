import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceHttp} from '../server/workspace-http.mjs';
import {WorkspaceError} from '../server/workspace-store.mjs';
import {HEAD,REPO} from '../../../tests/fixtures/public-code.mjs';

test('code API scopes current actor/project, preserves data, validates late responses and query input',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cobuild-code-http-'));
  const owner={subject:'fixture:owner',name:'Owner',email:'owner@example.test',role:'super_admin'};
  let actor=owner,forbidden=false,calls=0,behavior=async()=>({state:'ready',repository:{repositoryId:'123'},pullRequests:[]});
  const mail={enabled:true,identity:()=>{if(!actor)throw new WorkspaceError(401,'unauthenticated');return actor;},authorizeApplication:async()=>{if(forbidden)throw new WorkspaceError(403,'forbidden');}};
  const code={summary:async url=>{calls++;assert.equal(url,REPO);return behavior();},checks:async(url,input)=>{calls++;assert.equal(url,REPO);assert.deepEqual(input,{number:7,headSha:HEAD,repositoryId:'123'});return behavior();},close(){}};
  const ws=createWorkspaceHttp({directory,mail,localTest:true,knowledgeWorkerEnabled:false,projectSyncEnabled:false,projectCodeSource:code});
  let p=ws.store.create(owner,{name:'Code project',summary:'Synthetic',members:[],links:{repository:REPO,requirements:'',docs:'',demo:''}});
  const server=createServer((req,res)=>void ws.handle(req,res,new URL(req.url,'http://localhost').pathname,'127.0.0.1'));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const route='/api/workspace/projects/'+p.id+'/overview/code';
  async function read(path=route){const r=await fetch(base+path);assert.match(r.headers.get('cache-control'),/no-store/);return {status:r.status,value:await r.json()};}
  try{
    const audit=ws.store.audit(owner,p.id);assert.equal((await read()).value.state,'ready');
    assert.equal((await read(route+'/pulls/7/checks?head='+HEAD+'&repository=123')).value.state,'ready');
    assert.equal((await read(route+'?unknown=1')).status,400);
    assert.equal((await read(route+'/pulls/7/checks?head='+HEAD+'&head='+HEAD)).status,400);
    assert.equal((await read(route.replace(p.id,'11111111-1111-4111-8111-111111111111'))).status,404);
    assert.deepEqual(ws.store.audit(owner,p.id),audit);assert.equal(ws.store.get(owner,p.id).revision,p.revision);
    forbidden=true;const before=calls;assert.equal((await read()).status,403);assert.equal(calls,before);forbidden=false;
    behavior=async()=>{forbidden=true;return {state:'ready',private:'never returned'};};assert.equal((await read()).status,403);forbidden=false;
    behavior=async()=>{actor=null;return {state:'ready',private:'never returned'};};assert.equal((await read()).status,401);actor=owner;
    behavior=async()=>{actor={...owner,subject:'fixture:other'};return {state:'ready',private:'never returned'};};assert.equal((await read()).status,401);actor=owner;
    behavior=async()=>{p=ws.store.update(owner,p.id,{revision:p.revision,name:p.name,summary:'Changed during read',members:[],links:p.links});return {state:'ready',private:'never returned'};};
    const changed=await read();assert.equal(changed.value.state,'project_changed');assert.ok(!changed.value.private);
  }finally{await new Promise(r=>server.close(r));await ws.close();await rm(directory,{recursive:true,force:true});}
});
