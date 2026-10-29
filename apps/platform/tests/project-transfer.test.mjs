import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openWorkspaceStore,WorkspaceError} from '../server/workspace-store.mjs';
import {createWorkspaceHttp} from '../server/workspace-http.mjs';
import {createServer} from 'node:http';
const person=(subject,role='member')=>({subject,name:subject,email:subject+'@example.test',role});
const owner=person('owner'),recipient=person('recipient'),admin=person('admin','admin'),outsider=person('outsider');
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'project-transfer-')),profiles=new Map([owner,recipient,admin,outsider].map(p=>[p.subject,p]));let time=1_800_000_000_000;
 const config={directory,organizationId:randomUUID(),syncProjects:true,now:()=>time,resolveProjectActor:s=>{if(!profiles.has(s))throw Error('Disabled');return profiles.get(s);}};
 let store=openWorkspaceStore(config);const project=store.create(owner,{name:'Transfer fixture',summary:'Local synthetic transfer',members:[recipient].map(({subject,name,email})=>({subject,name,email})),links:{repository:'',requirements:'',docs:'',demo:''}});
 return {get store(){return store;},project,profiles,advance:n=>time+=n,reopen(){store.close();store=openWorkspaceStore(config);},close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
const start=(f,actor=owner,p=f.store.get(actor,f.project.id))=>f.store.transfer(actor,p.id,'start',{requestId:randomUUID(),revision:p.revision,recipientSubject:recipient.subject});
const finish=(f,p,actor=recipient,action='accept',requestId=randomUUID())=>f.store.transfer(actor,p.id,action,{requestId,transferId:p.ownershipTransfer.current.id});
test('transfer keeps former owner and milestone, updates snapshot exactly once, replays after restart',()=>{
 const f=fixture();try{
  f.store.addMilestone(owner,f.project.id,{title:'Old work',assignee:owner.subject,dueAt:null});
  const p=start(f),requestId=randomUUID(),data={requestId,transferId:p.ownershipTransfer.current.id};
  assert.equal(f.store.listTodos(recipient).items.filter(t=>t.kind==='project_transfer').length,1);
  f.reopen();const before=f.store.get(owner,p.id);const accepted=f.store.transfer(recipient,p.id,'accept',data);
  assert.equal(accepted.ownerSubject,recipient.subject);assert.equal(accepted.members[0].subject,owner.subject);
  assert.equal(accepted.milestones[0].assignee,owner.subject);assert.equal(accepted.revision,before.revision+1);
  assert.equal(f.store.get(owner,p.id).canEdit,false);assert.equal(accepted.canEdit,true);
  const generation=f.store.requirementsSync.generation(p.id),job=f.store.requirementsSync.claim();
  assert.equal(job.ownerSubject,recipient.subject);assert.equal(job.snapshot.ownerName,recipient.name);assert.ok(job.snapshot.memberNames.includes(owner.name));
  f.reopen();const replay=f.store.transfer(recipient,p.id,'accept',data);
  assert.equal(f.store.requirementsSync.generation(p.id),generation);
  assert.equal(replay.revision,accepted.revision);assert.equal(replay.transferResult.state,'accepted');
  assert.equal(f.store.audit(recipient,p.id).filter(r=>r.action==='transfer_accept').length,1);
  assert.equal(f.store.listTodos(recipient).items.some(t=>t.kind==='project_transfer'),false);
 }finally{f.close();}
});
test('admin may initiate but cannot accept for another member',()=>{
 const f=fixture();try{const p=start(f,admin);assert.throws(()=>finish(f,p,admin),e=>e.status===403);assert.throws(()=>finish(f,p,outsider),e=>e.status===403);assert.equal(finish(f,p).ownerSubject,recipient.subject);}finally{f.close();}
});
test('unrelated members cannot initiate; spoofed current admin role is ignored',()=>{
 const f=fixture();try{assert.throws(()=>start(f,outsider),e=>e.status===403);f.profiles.set(admin.subject,{...admin,role:'member'});assert.throws(()=>start(f,admin),e=>e.status===403);}finally{f.close();}
});
test('same request replays, mismatched input conflicts, active parallel request refused',()=>{
 const f=fixture();try{
  const data={requestId:randomUUID(),revision:1,recipientSubject:recipient.subject};
  const p=f.store.transfer(owner,f.project.id,'start',data);
  assert.equal(f.store.transfer(owner,p.id,'start',data).ownershipTransfer.current.id,p.ownershipTransfer.current.id);
  assert.throws(()=>f.store.transfer(owner,p.id,'start',{...data,revision:2}),e=>e.status===409&&e.code==='REQUEST_CONFLICT');
  assert.throws(()=>start(f,admin),e=>e.status===409);
 }finally{f.close();}
});
test('recipient may cancel; replay cannot cancel a newer request',()=>{
 const f=fixture();try{
  const p=start(f),key=randomUUID();finish(f,p,recipient,'cancel',key);
  const newer=start(f);const replay=finish(f,p,recipient,'cancel',key);
  assert.equal(replay.transferResult.state,'cancelled');assert.equal(replay.ownershipTransfer.current.id,newer.ownershipTransfer.current.id);assert.equal(replay.ownershipTransfer.current.state,'pending');
  assert.throws(()=>finish(f,p),e=>e.status===409);
 }finally{f.close();}
});
test('expiry rejects acceptance, removes todo, permits a fresh request',()=>{
 const f=fixture();try{const p=start(f);f.advance(24*60*60*1000);assert.equal(f.store.get(owner,p.id).ownershipTransfer.current.state,'expired');assert.throws(()=>finish(f,p),e=>e.status===409);assert.equal(f.store.listTodos(recipient).items.length,0);assert.notEqual(start(f).ownershipTransfer.current.id,p.ownershipTransfer.current.id);}finally{f.close();}
});
for(const kind of ['revision','member-removed','archive','recipient-disabled','owner-disabled','initiator-demoted'])test('accept rejects '+kind,()=>{
 const f=fixture();try{
  const p=start(f,admin);
  if(kind==='revision')f.store.update(owner,p.id,{revision:p.revision,name:p.name,summary:'Changed after transfer',members:p.members,links:p.links});
  if(kind==='member-removed')f.store.update(owner,p.id,{revision:p.revision,name:p.name,summary:p.summary,members:[],links:p.links});
  if(kind==='archive')f.store.archive(owner,p.id,{revision:p.revision,archived:true});
  if(kind==='recipient-disabled')f.profiles.delete(recipient.subject);
  if(kind==='owner-disabled')f.profiles.delete(owner.subject);
  if(kind==='initiator-demoted')f.profiles.set(admin.subject,{...admin,role:'member'});
  assert.throws(()=>finish(f,p),e=>[401,409].includes(e.status));assert.equal(f.store.get(admin,p.id).ownerSubject,owner.subject);
 }finally{f.close();}
});
test('cross-project transfer ID and non-member recipient are rejected',()=>{
 const f=fixture();try{
  const p=start(f),other=f.store.create(owner,{name:'Other',summary:'Other fixture',members:[],links:{repository:'',requirements:'',docs:'',demo:''}});
  assert.throws(()=>f.store.transfer(recipient,other.id,'accept',{requestId:randomUUID(),transferId:p.ownershipTransfer.current.id}),e=>e.status===404);
  assert.throws(()=>f.store.transfer(owner,other.id,'start',{requestId:randomUUID(),revision:other.revision,recipientSubject:outsider.subject}),e=>e.status===400);
 }finally{f.close();}
});

test('HTTP validates input and rejects a participant revoked during async authorization',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'transfer-http-')),profiles=new Map([owner,recipient].map(p=>[p.subject,p])),denied=new Set();let current=owner,revokeDuringCheck=false;
 const profile=s=>{const p=profiles.get(s);if(!p)throw new WorkspaceError(401,'unauthenticated');return p;};
 const assertApplication=a=>{if(denied.has(a.subject))throw new WorkspaceError(403,'forbidden');};
 const mail={suite:true,enabled:true,auth:{organizationId:randomUUID()},profile,identity:()=>profile(current.subject),assertApplication,authorizeApplication:async a=>{assertApplication(a);if(revokeDuringCheck&&a.subject===recipient.subject)denied.add(a.subject);}};
 const workspace=createWorkspaceHttp({directory,mail,localTest:true,knowledgeWorkerEnabled:false,projectSyncEnabled:false});
 const p=workspace.store.create(owner,{name:'HTTP transfer',summary:'Synthetic authorization boundary',members:[recipient].map(({subject,name,email})=>({subject,name,email})),links:{repository:'',requirements:'',docs:'',demo:''}});
 const server=createServer(async(req,res)=>{await workspace.handle(req,res,new URL(req.url,'http://localhost').pathname,'127.0.0.1');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));await workspace.close();rmSync(directory,{recursive:true,force:true});});
 const post=(action,data)=>fetch(origin+'/api/workspace/projects/'+p.id+'/transfer/'+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
 const input=()=>({requestId:randomUUID(),revision:p.revision,recipientSubject:recipient.subject});
 assert.equal((await post('start',null)).status,400);assert.equal((await post('start',{...input(),recipientSubject:[]})).status,400);
 profiles.delete(recipient.subject);assert.equal((await post('start',input())).status,409);profiles.set(recipient.subject,recipient);
 revokeDuringCheck=true;assert.equal((await post('start',input())).status,409);assert.equal(workspace.store.get(owner,p.id).ownershipTransfer.current,null);
 revokeDuringCheck=false;denied.clear();const r=await post('start',input());assert.equal(r.status,200);const started=await r.json();
 current=recipient;assert.equal((await post('accept',{requestId:randomUUID(),transferId:started.ownershipTransfer.current.id})).status,200);
 assert.equal(workspace.store.get(owner,p.id).ownerSubject,recipient.subject);
});
