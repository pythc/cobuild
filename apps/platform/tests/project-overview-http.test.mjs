import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceHttp} from '../server/workspace-http.mjs';
import {WorkspaceError} from '../server/workspace-store.mjs';

test('overview reads are isolated, actor scoped, and recheck permissions after a slow provider',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cobuild-overview-'));
  let actor={subject:'fixture:owner',name:'Fixture owner',email:'owner@example.test',role:'super_admin'};
  let forbidden='',calls=0,behavior=async()=>({state:'ready',counts:{total:2}});
  const mail={enabled:true,identity:()=>{if(!actor)throw new WorkspaceError(401,'unauthenticated');return actor;},
    authorizeApplication:async(_a,id)=>{if(forbidden===id)throw new WorkspaceError(403,'forbidden');}};
  const workspace=createWorkspaceHttp({directory,mail,knowledgeWorkerEnabled:false,projectSyncEnabled:false,localTest:true,
    projectOverviewClient:{requirements:async(a,id)=>{calls++;assert.equal(a.subject,'fixture:owner');assert.equal(id,project.id);return behavior();}}});
  const project=workspace.store.create(actor,{name:'Fixture project',summary:'Read only',members:[],links:{repository:'',requirements:'',docs:'',demo:''}});
  const before=workspace.store.audit(actor,project.id);
  const server=createServer((req,res)=>void workspace.handle(req,res,new URL(req.url,'http://localhost').pathname,'127.0.0.1'));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port+'/api/workspace/projects/'+project.id+'/overview/requirements';
  const read=async()=>{const r=await fetch(url);assert.match(r.headers.get('cache-control'),/no-store/);return {status:r.status,value:await r.json()};};
  try{
    assert.equal((await read()).value.counts.total,2);
    for(const [status,state] of [[403,'restricted'],[404,'not_synced'],[409,'conflict'],[412,'not_connected'],[503,'unavailable']]){
      behavior=async()=>{throw Object.assign(Error('private upstream detail'),{status});};
      assert.deepEqual((await read()).value,{state});
    }
    forbidden='requirements';const count=calls;assert.deepEqual((await read()).value,{state:'restricted'});assert.equal(calls,count);
    forbidden='';behavior=async()=>{forbidden='requirements';return {state:'ready',counts:{total:99}};};
    assert.deepEqual((await read()).value,{state:'restricted'});
    forbidden='';behavior=async()=>{forbidden='projects';return {state:'ready',counts:{total:99}};};assert.equal((await read()).status,403);
    forbidden='';behavior=async()=>{actor=null;return {state:'ready',counts:{total:99}};};assert.equal((await read()).status,401);
    actor={subject:'fixture:owner',name:'Fixture owner',email:'owner@example.test',role:'super_admin'};
    assert.deepEqual(workspace.store.audit(actor,project.id),before);
    assert.equal(workspace.store.get(actor,project.id).revision,project.revision);
  }finally{await new Promise(r=>server.close(r));await workspace.close();await rm(directory,{recursive:true,force:true});}
});
