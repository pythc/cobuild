import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { createWorkspaceHttp } from '../server/workspace-http.mjs';
import { MailAuthError } from '../server/mail-auth.mjs';
const alice={subject:'alice',name:'Alice',email:'alice@example.test',role:'member'};
const bob={subject:'bob',name:'Bob',email:'bob@example.test',role:'member'};
const fields={name:'Project A',summary:'Synthetic fixture',members:[],links:{repository:'',requirements:'',docs:'',demo:''}};
function fixture(t,{syncProjects=true}={}) {
  const directory=mkdtempSync(join(tmpdir(),'cobuild-commands-')),organizationId=randomUUID();let now=1000000;
  const open=()=>openWorkspaceStore({directory,organizationId,syncProjects,now:()=>now});
  let store=open();
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {get store(){return store;},restart(){store.close();store=open();return store;},advance(n){now+=n;}};
}
test('rename has stable resource, durable replay, live permission and revision conflict',t=>{
  const f=fixture(t);let p=f.store.create(alice,fields);
  const input={requestId:randomUUID(),revision:p.revision,name:'Project B'};
  const result=f.store.rename(alice,p.id,input);
  assert.equal(result.id,p.id);assert.equal(result.name,'Project B');assert.equal(result.operation.state,'queued');
  assert.equal(result.operation.resource.id,p.id);assert.equal(result.operation.revision,2);
  f.restart();
  const replay=f.store.rename(alice,p.id,input);
  assert.equal(replay.operation.id,result.operation.id);assert.equal(replay.revision,2);
  assert.throws(()=>f.store.rename(alice,p.id,{...input,name:'Changed'}),e=>e.code==='REQUEST_CONFLICT');
  assert.throws(()=>f.store.rename(alice,p.id,{...input,requestId:randomUUID()}),e=>e.status===409);
  assert.throws(()=>f.store.rename(bob,p.id,input),e=>e.status===403);
  assert.throws(()=>f.store.operation(bob,result.operation.id),e=>e.status===403);
  const adminInput={requestId:randomUUID(),revision:replay.revision,name:'Project C'};
  f.store.rename({...bob,role:'admin'},p.id,adminInput);
  assert.throws(()=>f.store.rename(bob,p.id,adminInput),e=>e.status===403,'downgraded admin cannot replay');
});
test('snapshot adapter recovers lost leases, records failures, coalesces and fences stale receipts',t=>{
  const f=fixture(t);let p=f.store.create(alice,fields);
  p=f.store.rename(alice,p.id,{requestId:randomUUID(),revision:p.revision,name:'One'});
  const first=p.operation.id,oldJob=f.store.requirementsSync.claim();
  assert.equal(f.store.operation(alice,first).state,'running');
  f.advance(120001);f.restart();const recovered=f.store.requirementsSync.claim();
  assert.notEqual(oldJob.lease,recovered.lease);
  assert.equal(f.store.requirementsSync.finish(oldJob,{projectId:p.id,url:'https://example.test/old'}),false);
  f.store.requirementsSync.fail(recovered,{code:'TIMEOUT'});
  assert.equal(f.store.operation(alice,first).state,'retry_wait');
  f.store.requirementsSync.retry(p.id);assert.equal(f.store.operation(alice,first).state,'queued');
  const working=f.store.requirementsSync.claim();
  p=f.store.rename(alice,p.id,{requestId:randomUUID(),revision:p.revision,name:'Two'});
  assert.equal(f.store.requirementsSync.finish(working,{projectId:p.id,url:'https://example.test/old'}),false);
  const final=f.store.requirementsSync.claim();
  assert.equal(final.name,'Two');
  assert.equal(f.store.requirementsSync.finish(final,{projectId:p.id,url:'https://example.test/final'}),true);
  for(const id of [first,p.operation.id]){
    const receipt=f.store.operation(alice,id);assert.equal(receipt.state,'succeeded');
    assert.equal(receipt.deliveries[0].receipt.mode,'snapshot-converged');
    assert.equal(receipt.deliveries[0].receipt.throughGeneration,final.revision);
  }
});
test('normal edit uses the same journal and disabled Makit does not create a pending delivery',t=>{
  const f=fixture(t,{syncProjects:false});const p=f.store.create(alice,fields);
  const input={...fields,name:'Edited',revision:p.revision,requestId:randomUUID()};
  const result=f.store.update(alice,p.id,input),replay=f.store.update(alice,p.id,input);
  assert.equal(result.operation.action,'kick.project.update');assert.equal(result.operation.state,'succeeded');
  assert.equal(result.operation.deliveries.length,0);assert.equal(replay.operation.id,result.operation.id);
  assert.equal(replay.revision,2);
  const archived=f.store.archive(alice,p.id,{revision:2,archived:true});
  assert.throws(()=>f.store.rename(alice,p.id,{requestId:randomUUID(),revision:archived.revision,name:'Archived'}),e=>e.status===409);
});

test('hard process termination after commit preserves receipt and single mutation',t=>{
  const directory=mkdtempSync(join(tmpdir(),'cobuild-kill-')),organizationId=randomUUID();
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {openWorkspaceStore} from ${JSON.stringify(new URL('../server/workspace-store.mjs',import.meta.url).href)};
    import {randomUUID} from 'node:crypto';
    const store=openWorkspaceStore(${JSON.stringify({directory,organizationId,syncProjects:true})});
    const actor=${JSON.stringify(alice)}, project=store.create(actor,${JSON.stringify(fields)});
    const input={requestId:randomUUID(),revision:project.revision,name:'Crash committed'};
    const value=store.rename(actor,project.id,input);
    process.stdout.write(JSON.stringify({input,id:project.id,operationId:value.operation.id}),()=>process.kill(process.pid,'SIGKILL'));
  `],{encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL');const saved=JSON.parse(child.stdout);
  const store=openWorkspaceStore({directory,organizationId,syncProjects:true});
  try {
    const replay=store.rename(alice,saved.id,saved.input);
    assert.equal(replay.operation.id,saved.operationId);assert.equal(replay.revision,2);
    assert.equal(store.audit(alice,saved.id).filter(e=>e.action==='update').length,1);
  } finally {store.close();}
});

test('HTTP command and receipt check live application permission plus same-origin writes',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'cobuild-command-http-'));let allowed=true,current=alice;
  const workspace=createWorkspaceHttp({directory,localTest:true,knowledgeWorkerEnabled:false,projectSyncEnabled:false,
    mail:{enabled:true,auth:{organizationId:randomUUID()},identity:()=>current,
      async authorizeApplication(){if(!allowed)throw new MailAuthError(403,'denied');},
      assertApplication(){if(!allowed)throw new MailAuthError(403,'denied');},
    }});
  const project=workspace.store.create(alice,fields);
  const server=createServer(async(req,res)=>{await workspace.handle(req,res,new URL(req.url,'http://localhost').pathname,'127.0.0.1');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(r=>server.close(r));await workspace.close();rmSync(directory,{recursive:true,force:true});});
  const input={requestId:randomUUID(),revision:1,name:'HTTP command'};
  const post=(headers={})=>fetch(origin+'/api/workspace/projects/'+project.id+'/rename',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
  assert.equal((await post({Origin:'https://untrusted.example'})).status,403);
  let response=await post();assert.equal(response.status,200);const result=await response.json();
  allowed=false;
  assert.equal((await post()).status,403);
  assert.equal((await fetch(origin+'/api/workspace/projects/operations/'+result.operation.id)).status,403);
  allowed=true;current=bob;
  assert.equal((await post()).status,403);
  assert.equal(workspace.store.get(alice,project.id).revision,2);
});

test('additive activation preserves legacy data and reconciles a compatibility writer receipt',t=>{
  const directory=mkdtempSync(join(tmpdir(),'cobuild-legacy-')),organizationId=randomUUID();
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  // No organizationId uses the preserved pre-contract adapter, without a ledger.
  let store=openWorkspaceStore({directory,syncProjects:true});
  const original=store.create(alice,fields);store.close();
  store=openWorkspaceStore({directory,syncProjects:true,organizationId});
  assert.deepEqual(store.get(alice,original.id),original,'activation does not rewrite project data');
  const renamed=store.rename(alice,original.id,{requestId:randomUUID(),revision:original.revision,name:'Additive activation'});
  store.close();
  store=openWorkspaceStore({directory,syncProjects:true});
  const job=store.requirementsSync.claim();
  assert.equal(store.requirementsSync.finish(job,{projectId:job.id,url:'https://example.test/project'}),true);
  store.close();
  store=openWorkspaceStore({directory,syncProjects:true,organizationId});
  try {
    assert.equal(store.get(alice,original.id).name,'Additive activation');
    assert.equal(store.operation(alice,renamed.operation.id).state,'succeeded');
    assert.equal(store.operation(alice,renamed.operation.id).deliveries[0].receipt.throughGeneration,job.revision);
  } finally {store.close();}
});

test('managed knowledge rename survives restart, fences stale receipts and retains per-app failure',t=>{
  const f=fixture(t,{syncProjects:false}),admin={...alice,role:'admin'};
  let p=f.store.create(alice,{...fields,createKnowledgeSpace:true});
  p=f.store.apply(alice,p.id,{revision:p.revision,application:'Fixture'});
  p=f.store.review(admin,p.id,{revision:p.revision,decision:'approve',note:''});
  let job=f.store.knowledgeSpaces.claim();const spaceId=randomUUID(),url='https://knowledge.110-lab.cn/s/project';
  f.store.knowledgeSpaces.finish(job,{spaceId,url,name:job.name,mode:'managed'});
  p=f.store.get(alice,p.id);
  p=f.store.rename(alice,p.id,{requestId:randomUUID(),revision:p.revision,name:'Renamed'});
  const op=p.operation.id,stale=f.store.knowledgeSpaces.claim();
  assert.equal(stale.expectedName,fields.name);assert.equal(stale.name,'Renamed');
  p=f.store.rename(alice,p.id,{requestId:randomUUID(),revision:p.revision,name:'Final'});
  assert.equal(f.store.knowledgeSpaces.finish(stale,{spaceId,url,name:'Renamed',mode:'managed'}),false);
  f.restart();job=f.store.knowledgeSpaces.claim();assert.equal(job.name,'Final');
  f.store.knowledgeSpaces.fail(job,{permanent:true,code:'KNOWLEDGE_NAME_CONFLICT'});
  assert.equal(f.store.operation(alice,op).state,'blocked');
  assert.equal(f.store.get(alice,p.id).knowledgeSpace.errorCode,'KNOWLEDGE_NAME_CONFLICT');
  f.store.knowledgeSpaces.retry(p.id);job=f.store.knowledgeSpaces.claim();
  f.store.knowledgeSpaces.finish(job,{spaceId,url,name:'Final',mode:'managed'});
  assert.equal(f.store.operation(alice,op).state,'succeeded');
  assert.equal(f.store.get(alice,p.id).knowledgeSpace.spaceId,spaceId);
  p=f.store.get(alice,p.id);
  p=f.store.archive(alice,p.id,{revision:p.revision,archived:true});job=f.store.knowledgeSpaces.claim();
  assert.equal(job.archived,true);f.store.knowledgeSpaces.finish(job,{spaceId,url,name:'Final',mode:'managed'});
  assert.equal(f.store.get(alice,p.id).knowledgeSpace.state,'archived');
  assert.deepEqual(f.store.projectWriteState([fields.name,'Renamed','Final','Other']).blockedNames.sort(),[fields.name,'Renamed','Final'].sort());
  p=f.store.archive(alice,p.id,{revision:p.revision,archived:false});job=f.store.knowledgeSpaces.claim();
  assert.equal(job.archived,false);f.store.knowledgeSpaces.finish(job,{spaceId,url,name:'Final',mode:'managed'});
  assert.deepEqual(f.store.projectWriteState(['Final']).blockedNames,[]);
});

test('archive before first space creation does not invent a remote link; legacy spaces stay independent',t=>{
  const f=fixture(t,{syncProjects:false}),admin={...alice,role:'admin'};
  let p=f.store.create(alice,{...fields,createKnowledgeSpace:true});
  p=f.store.apply(alice,p.id,{revision:p.revision,application:'Fixture'});
  p=f.store.review(admin,p.id,{revision:p.revision,decision:'approve',note:''});
  p=f.store.archive(alice,p.id,{revision:p.revision,archived:true});
  let job=f.store.knowledgeSpaces.claim();f.store.knowledgeSpaces.finish(job,{spaceId:null,url:null,mode:'suspended'});
  assert.equal(f.store.get(alice,p.id).knowledgeSpace.url,null);
  p=f.store.archive(alice,p.id,{revision:p.revision,archived:false});
  job=f.store.knowledgeSpaces.claim();f.store.knowledgeSpaces.finish(job,{spaceId:randomUUID(),url:'https://knowledge.110-lab.cn/s/legacy',name:'Independent name',mode:'legacy'});
  p=f.store.get(alice,p.id);p=f.store.rename(alice,p.id,{requestId:randomUUID(),revision:p.revision,name:'Unrelated'});
  assert.equal(f.store.knowledgeSpaces.claim(),null);assert.equal(p.operation.state,'succeeded');
});

test('archive and restore receipts survive lost replies and coalesced downstream retries',t=>{
  const f=fixture(t),admin={...bob,role:'admin'};
  let p=f.store.create(alice,{...fields,createKnowledgeSpace:true});
  p=f.store.apply(alice,p.id,{revision:p.revision,application:'Fixture'});
  p=f.store.review(admin,p.id,{revision:p.revision,decision:'approve',note:''});
  const spaceId=randomUUID(),url='https://knowledge.110-lab.cn/s/fixture';
  f.store.knowledgeSpaces.finish(f.store.knowledgeSpaces.claim(),{spaceId,url,mode:'managed'});
  p=f.store.get(alice,p.id);
  const input={requestId:randomUUID(),revision:p.revision,archived:true};
  const archived=f.store.archive(alice,p.id,input);
  assert.equal(archived.operation.action,'kick.project.archive');
  assert.equal(archived.operation.deliveries.length,2);
  const old=f.store.knowledgeSpaces.claim();
  f.restart();
  const replay=f.store.archive(alice,p.id,input);
  assert.equal(replay.operation.id,archived.operation.id);assert.equal(replay.revision,archived.revision);
  assert.equal(f.store.audit(alice,p.id).filter(e=>e.action==='archive').length,1);
  assert.throws(()=>f.store.archive(alice,p.id,{...input,archived:false}),e=>e.code==='REQUEST_CONFLICT');
  assert.throws(()=>f.store.archive(alice,p.id,{...input,requestId:randomUUID()}),e=>e.status===409&&e.message==='revision_conflict');
  assert.throws(()=>f.store.archive(bob,p.id,input),e=>e.status===403);
  const restore={requestId:randomUUID(),revision:replay.revision,archived:false};
  const restored=f.store.archive(admin,p.id,restore);
  assert.equal(restored.operation.action,'kick.project.restore');
  assert.throws(()=>f.store.archive(bob,p.id,restore),e=>e.status===403);
  assert.throws(()=>f.store.operation(bob,restored.operation.id),e=>e.status===403);
  assert.equal(f.store.knowledgeSpaces.finish(old,{spaceId,url,mode:'managed'}),false);
  const makit=f.store.requirementsSync.claim();
  f.store.requirementsSync.finish(makit,{projectId:p.id,url:'https://example.test/project'});
  let knowledge=f.store.knowledgeSpaces.claim();
  f.store.knowledgeSpaces.fail(knowledge,{permanent:true,code:'FIXTURE_UNAVAILABLE'});
  const partial=f.store.operation(alice,archived.operation.id);
  assert.equal(partial.state,'blocked');
  assert.equal(partial.deliveries.find(d=>d.consumer.startsWith('makit')).state,'succeeded');
  f.restart();f.store.knowledgeSpaces.retry(p.id);knowledge=f.store.knowledgeSpaces.claim();
  f.store.knowledgeSpaces.finish(knowledge,{spaceId,url,mode:'managed'});
  for(const id of [archived.operation.id,restored.operation.id]){
    const operation=f.store.operation(alice,id),receipt=operation.deliveries.find(d=>d.consumer.startsWith('weknow')).receipt;
    assert.equal(operation.state,'succeeded');assert.equal(receipt.confirmation,'snapshot-converged');
    assert.equal(receipt.throughGeneration,knowledge.revision);assert.ok(receipt.throughGeneration>=restored.revision);assert.equal(receipt.archived,false);
  }
  const late=f.store.archive(alice,p.id,input);
  assert.equal(late.archived,false,'replay returns current project, not old archived content');
  assert.equal(late.operation.id,archived.operation.id);
  assert.equal(f.store.get(alice,p.id).knowledgeSpace.spaceId,spaceId);
});
