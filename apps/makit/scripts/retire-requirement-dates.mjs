#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export const RETIRED_DATES=['开始时间','开发预计启动时间','开发预计结束时间','预计提测时间','截止时间'];
function text(value){return Array.isArray(value)?value.map(text).join(''):typeof value==='object'&&value?text(value.text||value.name):String(value||'');}
const present=value=>value!==null&&value!==undefined&&value!==''&&!(Array.isArray(value)&&value.length===0);
export function retirementPlan(records){return records.filter(r=>text(r.fields['需求类型'])!=='工单').map(r=>({id:r.id,fields:Object.fromEntries(RETIRED_DATES.filter(k=>present(r.fields[k])).map(k=>[k,r.fields[k]]))})).filter(r=>Object.keys(r.fields).length);}
function envelope(value){for(const v of [value?.data?.data,value?.data,value])if(v&&Array.isArray(v.fields)&&Array.isArray(v.data)&&Array.isArray(v.record_id_list))return v;throw new Error('Unsupported Base response; no writes attempted');}
export function decodeRecords(value){const e=envelope(value);if(e.record_id_list.length!==e.data.length)throw new Error('Incomplete Base response');return {fields:e.fields,hasMore:!!e.has_more,records:e.data.map((row,i)=>({id:e.record_id_list[i],fields:Object.fromEntries(e.fields.map((field,j)=>[field,row[j]]))}))};}
export function runRetirement({baseToken,tableId,backup,apply=false,cli=callCli,pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}){
  if(!baseToken||!tableId)throw new Error('--base-token and --table-id are required');
  const common=['--base-token',baseToken,'--table-id',tableId,'--as','user'];
  const projection=['需求类型',...RETIRED_DATES].flatMap(f=>['--field-id',f]);
  const list=()=>{const rows=[];let offset=0;for(;;){const page=decodeRecords(cli(['base','+record-list',...common,...projection,'--limit','200','--offset',String(offset),'--format','json']));if(['需求类型',...RETIRED_DATES].some(field=>!page.fields.includes(field)))throw new Error('Projected columns are incomplete; no clearing is allowed');rows.push(...page.records);if(!page.hasMore)return rows;if(!page.records.length)throw new Error('Pagination stalled');offset+=page.records.length;}};
  const records=list(),plan=retirementPlan(records);
  if(!apply)return {mode:'plan',records:records.length,affectedRecords:plan.length,cells:plan.reduce((n,r)=>n+Object.keys(r.fields).length,0)};
  if(!backup)throw new Error('--backup is required before any clearing');
  // Fail if an operator would accidentally overwrite a previous backup.
  writeFileSync(backup,JSON.stringify({version:1,baseToken,tableId,createdAt:new Date().toISOString(),records:plan},null,2),{flag:'wx',mode:0o600});
  const fd=openSync(backup,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  for(let i=0;i<plan.length;i+=200){
    const batch=plan.slice(i,i+200),ids=batch.flatMap(r=>['--record-id',r.id]);
    const latest=decodeRecords(cli(['base','+record-get',...common,...projection,...ids,'--format','json'])).records;
    if(latest.length!==batch.length||batch.some(old=>{const current=latest.find(r=>r.id===old.id);return !current||text(current.fields['需求类型'])==='工单'||Object.entries(old.fields).some(([k,v])=>JSON.stringify(current.fields[k])!==JSON.stringify(v));}))throw new Error('Records changed after backup; stop and prepare a fresh plan');
    const update_records=Object.fromEntries(batch.map(r=>[r.id,Object.fromEntries(Object.keys(r.fields).map(k=>[k,null]))]));
    const result=cli(['base','+record-batch-update',...common,'--json',JSON.stringify({update_records})]);
    if(result?.data?.ignored_fields?.length)throw new Error('Provider ignored fields; inspect backup and current records');
  }
  let remaining=retirementPlan(list());for(let attempt=0;remaining.length&&attempt<5;attempt++){pause(2000);remaining=retirementPlan(list());}if(remaining.length)throw new Error('Read-back found uncleared or newly edited cells; inspect before retry');
  return {mode:'applied',affectedRecords:plan.length,verified:true,backup};
}
function callCli(args){const result=spawnSync('lark-cli',args,{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});if(result.status!==0)throw new Error('lark-cli failed; resolve login/permission or service errors before retrying');const value=JSON.parse(result.stdout);if(value.ok===false)throw new Error('Base rejected the operation');if(value._notice?.length)console.error('lark-cli returned a notice; inspect CLI authorization before further operations');return value;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};
  try{console.log(JSON.stringify(runRetirement({baseToken:get('--base-token'),tableId:get('--table-id'),backup:get('--backup'),apply:args.includes('--apply')})));}catch(e){console.error(e.message);process.exitCode=1;}
}
