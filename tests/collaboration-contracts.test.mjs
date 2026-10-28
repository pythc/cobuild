import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJSON, createModuleRegistry, resourceRef } from '../packages/contracts/index.mjs';
import { capabilities, registry as suite } from '../packages/config/index.mjs';
import { operationStore } from '../packages/operations/sqlite-store.mjs';

test('resource identity and registered capabilities are strict, independent of display names',()=>{
  const r={organizationId:randomUUID(),appId:'kick',type:'project',id:randomUUID()};
  assert.deepEqual(resourceRef(r),r);
  assert.throws(()=>resourceRef({...r,name:'Project'}));
  assert.throws(()=>capabilities.assertAction('kick.project.rename',{...r,appId:'weknow'}));
  assert.throws(()=>capabilities.assertAction('kick.project.delete',r));
  assert.equal(capabilities.applicationOwner('projects'),'kick');
  assert.equal(capabilities.applicationOwner('not-registered'),undefined);
  for (const change of [
    m=>m[0].contractVersion=999,
    m=>m[0].dependsOn=['missing'],
    m=>m[0].dependsOn=['kick'],
    m=>m[1].actions=['weknow.page.delete'],
    m=>m[1].applications.push('organization'),
  ]) {const copy=structuredClone(suite.modules);change(copy);assert.throws(()=>createModuleRegistry(copy));}
});
test('canonical fingerprint input rejects non-JSON ambiguity',()=>{
  assert.equal(canonicalJSON({b:2,a:[null,'a']}),'\u007b"a":[null,"a"],"b":2\u007d');
  for(const value of [{a:undefined},NaN,Infinity,new Date(),{a:()=>{}}])assert.throws(()=>canonicalJSON(value));
});
test('business mutation, operation, event and projection binding roll back together',()=>{
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON; CREATE TABLE business(revision INTEGER); INSERT INTO business VALUES(1);');
  const store=operationStore(db,{registry:capabilities});
  const cmd={subject:'member',requestId:randomUUID(),action:'kick.project.rename',resource:{organizationId:randomUUID(),appId:'kick',type:'project',id:randomUUID()},input:{revision:1,name:'New'}};
  const mutate=()=>{db.exec('UPDATE business SET revision=2');return {revision:2,event:{type:'kick.project.renamed.v1',data:{name:'New'}},projections:[{consumer:'makit.project-snapshot.v1',key:cmd.resource.id,generation:2}]};};
  try {
    db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON collaboration_events_v1 BEGIN SELECT RAISE(ABORT,'fault injection'); END;");
    assert.throws(()=>store.execute(cmd,{authorize(){},mutate}));
    assert.equal(db.prepare('SELECT revision FROM business').get().revision,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM collaboration_operations_v1').get().n,0);
    db.exec('DROP TRIGGER fail_event');
    const result=store.execute(cmd,{authorize(){},mutate});
    assert.equal(result.state,'queued');
    const replay=store.execute(cmd,{authorize(){},mutate:()=>assert.fail('replayed mutation')});
    assert.equal(replay.id,result.id);assert.equal(replay.replayed,true);
    assert.throws(()=>store.execute({...cmd,input:{...cmd.input,name:'Different'}},{authorize(){},mutate}),e=>e.code==='REQUEST_CONFLICT');
    assert.throws(()=>store.execute(cmd,{authorize(){throw Error('revoked');},mutate}),/revoked/);
    store.project('makit.project-snapshot.v1',cmd.resource.id,3,'succeeded',{mode:'snapshot-converged',throughGeneration:3});
    assert.equal(store.get(result.id,()=>{}).deliveries[0].receipt.throughGeneration,3);
    assert.equal(store.get(result.id,()=>{}).state,'succeeded');
    store.project('makit.project-snapshot.v1',cmd.resource.id,4,'queued');
    assert.equal(store.get(result.id,()=>{}).state,'succeeded','new work cannot reset confirmed receipt');
  } finally {db.close();}
});
