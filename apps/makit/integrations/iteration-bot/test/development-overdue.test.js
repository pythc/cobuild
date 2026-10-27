import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDevelopmentOverdue,developmentOverdueTargets} from '../src/development-overdue.js';
const start=1700000000000;
const requirement={recordId:'rec_fixture',title:'虚构验证需求',type:'产品需求',status:'开发中',effort:.5,actualStart:start,developers:[{id:'ou_fixture',name:'虚构成员'}]};
function setup(t,extra={}){const rootDir=mkdtempSync(join(tmpdir(),'development-overdue-'));t.after(()=>rmSync(rootDir,{recursive:true,force:true}));let clock=start+86400000,calls=0;
 const input={rootDir,config:{developmentOverdue:{enabled:true},runtime:{timezone:'Asia/Shanghai'}},base:{listAllRequirements:async()=>[requirement]},sendPost:async()=>{calls++;return{response:{data:{message_id:'om_fixture'}}};},requirementUrl:r=>'https://example.test/requirements/'+r.recordId,now:()=>clock,...extra};return {input,advance:n=>clock+=n,calls:()=>calls};}
test('natural-day threshold is strict, supports fractional days and targets unique developers only',()=>{
 assert.equal(developmentOverdueTargets(requirement,start+43200000).length,0);assert.equal(developmentOverdueTargets(requirement,start+43200001).length,1);
 const result=developmentOverdueTargets({...requirement,developers:[...requirement.developers,...requirement.developers,{id:'oc_group'}]},start+86400000);assert.equal(result.length,1);assert.equal(result[0].person.id,'ou_fixture');
 for(const fields of [{status:'测试中'},{type:'工单'},{effort:null},{effort:NaN},{effort:-1},{effort:Number.MAX_VALUE},{actualStart:null}])assert.equal(developmentOverdueTargets({...requirement,...fields},start+86400000).length,0);
});
test('one delivery persists across scans and restart; a new development entry has its own key',async t=>{
 const s=setup(t);let app=createDevelopmentOverdue(s.input);assert.equal((await app.runOnce()).sent,1);s.advance(300001);await app.runOnce();assert.equal(s.calls(),1);app.close();
 app=createDevelopmentOverdue(s.input);await app.runOnce();assert.equal(s.calls(),1);app.close();
 app=createDevelopmentOverdue({...s.input,base:{listAllRequirements:async()=>[{...requirement,actualStart:start-86400000}]}});await app.runOnce();assert.equal(s.calls(),2);app.close();
});
test('unknown network outcomes and in-flight crash reservations are not resent',async t=>{
 const s=setup(t,{sendPost:async()=>{throw new Error('ambiguous transport');}});let app=createDevelopmentOverdue(s.input);assert.equal((await app.runOnce()).unknown,1);app.close();
 let sends=0;app=createDevelopmentOverdue({...s.input,sendPost:async()=>{sends++;}});await app.runOnce();assert.equal(sends,0);app.close();
 const db=new DatabaseSync(join(s.input.rootDir,'state/development-overdue/deliveries.sqlite'));db.exec("UPDATE reminders SET state='sending'");db.close();
 app=createDevelopmentOverdue({...s.input,sendPost:async()=>{sends++;}});await app.runOnce();assert.equal(sends,0);app.close();
});
test('safe policy suppression may retry later, and concurrent scans share one durable reservation',async t=>{
 let blocked=true,sends=0;const s=setup(t,{sendPost:async()=>{sends++;return blocked?{blocked:true}:{response:{data:{message_id:'om_test'}}};}});const app=createDevelopmentOverdue(s.input);
 assert.equal((await app.runOnce()).blocked,1);blocked=false;s.advance(300001);await Promise.all([app.runOnce(),app.runOnce()]);assert.equal(sends,2);app.close();
});
test('feature flag disables scanning and the delivered post uses the canonical URL adapter',async t=>{
 let payload;const s=setup(t,{sendPost:async(target,content)=>{assert.deepEqual(target,{userId:'ou_fixture'});payload=content;return{response:{data:{message_id:'om_test'}}};}});
 let app=createDevelopmentOverdue({...s.input,config:{developmentOverdue:{enabled:false}}});await app.runOnce();assert.equal(payload,undefined);app.close();
 app=createDevelopmentOverdue(s.input);await app.runOnce();assert.equal(payload.zh_cn.content.at(-1)[0].href,'https://example.test/requirements/rec_fixture');app.close();
});
