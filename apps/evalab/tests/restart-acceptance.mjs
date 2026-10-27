import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const config=JSON.parse(await readFile(process.env.TEST_CONFIG_PATH,'utf8'));
const base=config.TEST_ORIGIN;
function session(){
 let cookie='',csrf='';
 return async(path,method='GET',body)=>{
  const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:base,Cookie:cookie,'X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  const j=await r.json();assert.equal(r.status,200,`${path}: ${JSON.stringify(j)}`);
  if(j.csrfToken)csrf=j.csrfToken;return j;
 };
}
const admin=session(),user=session(),second=JSON.parse(config.TEST_CANDIDATES_JSON)[1];
await admin('/api/auth/login','POST',{account:config.TEST_ADMIN_EMAIL,password:config.TEST_ADMIN_PASSWORD});
await user('/api/auth/login','POST',{account:second.email,password:second.password});
if(process.argv[2]==='before'){
 const ready=(await user('/api/enrollments')).enrollments.find(e=>e.state==='READY');assert.ok(ready);
 await admin(`/api/admin/batches/${ready.batchId}`,'PATCH',{status:'OPEN'});
 try{
  await user(`/api/enrollments/${ready.id}/consent`,'POST',{version:'assessment-consent-v1',accepted:true});
  const {token}=await user(`/api/enrollments/${ready.id}/mcp-token`,'POST',{});
  const mcp=new Client({name:'restart-check',version:'1.0'});
  await mcp.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  try{const result=await mcp.callTool({name:'test_connection',arguments:{}});assert.notEqual(result.isError,true);}finally{await mcp.close();}
  const started=(await user(`/api/enrollments/${ready.id}/start`,'POST',{confirmed:true,expectedDurationHours:24})).enrollment;
  await writeFile(process.env.TEST_SNAPSHOT_PATH,JSON.stringify({id:started.id,startedAt:started.startedAt,deadline:started.deadline,question:started.question}));
  console.log('PASS Active exam captured before application restart');
 }finally{await admin(`/api/admin/batches/${ready.batchId}`,'PATCH',{status:'DRAFT'});}
}else{
 const before=JSON.parse(await readFile(process.env.TEST_SNAPSHOT_PATH,'utf8'));
 const after=(await user(`/api/enrollments/${before.id}`)).enrollment;
 for(const k of ['startedAt','deadline','question'])assert.deepEqual(after[k],before[k]);
 assert.equal(after.state,'ACTIVE');
 const first=JSON.parse(config.TEST_CANDIDATES_JSON)[0],u=session();
 await u('/api/auth/login','POST',{account:first.email,password:first.password});
 const finished=(await u('/api/enrollments')).enrollments.find(e=>e.state==='FINALIZED');
 assert.ok(finished?.submission?.id);
 console.log('PASS Restart preserves active clock, question snapshot and finalized receipt');
}
