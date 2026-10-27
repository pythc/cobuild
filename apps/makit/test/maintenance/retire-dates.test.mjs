import test from 'node:test';
import assert from 'node:assert/strict';
import {retirementPlan,decodeRecords,runRetirement} from '../../scripts/retire-requirement-dates.mjs';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('retirement excludes tickets and keeps automatic timestamps and effort out of the patch',()=>{
 const plan=retirementPlan([{id:'recA',fields:{需求类型:['产品需求'],开始时间:123,截止时间:456,工作量:3,实际开始时间:789}},{id:'recB',fields:{需求类型:['工单'],截止时间:456}}]);
 assert.deepEqual(plan,[{id:'recA',fields:{开始时间:123,截止时间:456}}]);
});
test('CLI envelope decoding fails closed for missing rows',()=>{
 assert.deepEqual(decodeRecords({data:{fields:['开始时间'],data:[[1]],record_id_list:['recA'],has_more:false}}).records,[{id:'recA',fields:{开始时间:1}}]);
 assert.throws(()=>decodeRecords({data:{fields:[],data:[[]],record_id_list:[]}}));
});
test('apply backs up before writes, clears only reviewed cells and verifies actual values',t=>{
 const dir=mkdtempSync(join(tmpdir(),'date-clear-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let current=123,writes=0;
 const backup=join(dir,'backup.json');
 const cli=args=>{
  if(args[1]==='+record-batch-update'){assert.equal(JSON.parse(readFileSync(backup)).records[0].fields.开始时间,123);assert.equal(statSync(backup).mode&0o777,0o600);const payload=JSON.parse(args[args.indexOf('--json')+1]);assert.deepEqual(payload,{update_records:{recA:{开始时间:null}}});current=null;writes++;return {ok:true,data:{}};}
  return {data:{fields:['需求类型','开始时间','开发预计启动时间','开发预计结束时间','预计提测时间','截止时间'],data:[[['产品需求'],current,null,null,null,null]],record_id_list:['recA']}};
 };
 assert.equal(runRetirement({baseToken:'test',tableId:'table',cli}).mode,'plan');assert.equal(writes,0);
 assert.equal(runRetirement({baseToken:'test',tableId:'table',backup,apply:true,cli}).verified,true);assert.equal(writes,1);
});

test('eventual read visibility is rechecked without repeating the write',t=>{
 const dir=mkdtempSync(join(tmpdir(),'date-eventual-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let writes=0,readsAfterWrite=0,pauses=0;
 const cli=args=>{if(args[1]==='+record-batch-update'){writes++;return {ok:true,data:{}};}const value=writes&&++readsAfterWrite>1?null:123;return {data:{fields:['需求类型','开始时间','开发预计启动时间','开发预计结束时间','预计提测时间','截止时间'],data:[[['产品需求'],value,null,null,null,null]],record_id_list:['recA']}};};
 assert.equal(runRetirement({baseToken:'test',tableId:'table',backup:join(dir,'backup.json'),apply:true,cli,pause:()=>pauses++}).verified,true);assert.equal(writes,1);assert.equal(pauses,1);
});
