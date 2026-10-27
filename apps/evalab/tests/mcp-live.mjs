import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,realpath,symlink,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const config=JSON.parse(await readFile(process.env.TEST_CONFIG_PATH,'utf8'));
const base=config.TEST_ORIGIN,out=process.env.TEST_OUTPUT_DIR;
assert.ok(base==='https://47.109.176.127' && out);
const accounts=JSON.parse(config.TEST_CANDIDATES_JSON),checks=[];
const sha=x=>createHash('sha256').update(x).digest('hex');
const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
const canonical=x=>JSON.stringify(sort(x));
async function check(name,fn){await fn();checks.push(name);console.log('PASS',name);}
function session(){let cookie='',csrf='';return async(url,method='GET',body,expected=[200,201])=>{
 const r=await fetch(base+url,{method,headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
 const j=await r.json();if(j.csrfToken)csrf=j.csrfToken;
 assert.ok(expected.includes(r.status),`${method} ${url}: ${r.status} ${JSON.stringify(j).slice(0,200)}`);return j;
};}
async function call(c,name,args={}){const r=await c.callTool({name,arguments:args});if(r.isError)throw Error(r.content?.find(x=>x.type==='text')?.text||'MCP rejected');return r.structuredContent||JSON.parse(r.content.find(x=>x.type==='text').text);}
async function remote(token){const c=new Client({name:'mcp-live-review',version:'1.0'});await c.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return c;}
async function raw(token,headers={},query=''){return fetch(base+'/mcp'+query,{method:'POST',headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} :{}),...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'negative-test',version:'1'}}}),signal:AbortSignal.timeout(15000)});}
const admin=session(),user=session(),other=session();let batch,enrollment,bridge,mcp,old,root,approval,payload;
try{
 await admin('/api/auth/login','POST',{account:config.TEST_ADMIN_EMAIL,password:config.TEST_ADMIN_PASSWORD});
 await user('/api/auth/login','POST',{account:accounts[0].email,password:accounts[0].password});
 await other('/api/auth/login','POST',{account:accounts[1].email,password:accounts[1].password});
 await check('Public download matches the reviewed 0.1.1 package',async()=>{
  const r=await fetch(base+'/downloads/context-bridge-0.1.1.tgz');assert.equal(r.status,200);
  assert.equal(sha(Buffer.from(await r.arrayBuffer())),sha(await readFile('public/downloads/context-bridge-0.1.1.tgz')));
 });
 await check('Anonymous and invalid bearer access rejected',async()=>{assert.equal((await raw()).status,401);assert.equal((await raw('invalid-fixture-token-123')).status,401);});
 const round=(await admin('/api/admin/rounds','POST',{name:`MCP 专项验收-${Date.now()}`})).round;
 batch=(await admin('/api/admin/batches','POST',{roundId:round.id,name:'MCP 安装包与上传验收',description:'专用合成数据',opensAt:new Date(Date.now()-60000).toISOString(),startClosesAt:new Date(Date.now()+3600000).toISOString(),durationHours:24,status:'OPEN'})).batch;
 await admin('/api/admin/questions','POST',{batchId:batch.id,direction:'DEVELOPMENT_TEST',title:'MCP 提交流程验收',content:'使用合成对话验证本地预览、网页批准和上传回执。',published:true,attachmentIds:[]});
 enrollment=(await user('/api/enrollments','POST',{batchId:batch.id,direction:'DEVELOPMENT_TEST'})).enrollment;
 await user(`/api/enrollments/${enrollment.id}/consent`,'POST',{version:'assessment-consent-v1',accepted:true});
 const oldToken=(await user(`/api/enrollments/${enrollment.id}/mcp-token`,'POST',{})).token;
 old=await remote(oldToken);
 await check('Four remote tools available; no approval or finalization tool',async()=>{
  assert.deepEqual((await old.listTools()).tools.map(t=>t.name).sort(),['exam_status','prepare_materials','submit_materials','test_connection']);
  const s=await call(old,'exam_status');assert.equal(s.enrollment.id,enrollment.id);assert.equal(s.enrollment.state,'READY');assert.equal(s.enrollment.question,null);
 });
 await call(old,'test_connection');
 const token=(await user(`/api/enrollments/${enrollment.id}/mcp-token`,'POST',{})).token;
 await check('Token rotation revokes old token and requires a fresh preflight',async()=>{
  await assert.rejects(()=>call(old,'exam_status'));
  assert.equal((await user(`/api/enrollments/${enrollment.id}`)).enrollment.mcpConnected,false);
  await user(`/api/enrollments/${enrollment.id}/start`,'POST',{confirmed:true,expectedDurationHours:24},[400,403,409,422]);
 });
 await check('Foreign origin and URL tokens rejected',async()=>{
  assert.equal((await raw(token,{Origin:'https://untrusted.example'})).status,403);
  assert.ok([400,401,403].includes((await raw(undefined,{},'?token='+encodeURIComponent(token))).status));
 });
 root=await realpath(await mkdtemp(path.join(os.tmpdir(),'assessment-mcp-live-')));
 const workspace=path.join(root,'exam');await mkdir(workspace);
 const lines=[{type:'session_meta',payload:{cwd:workspace,cli_version:'synthetic-test'}},{type:'turn_context',payload:{model:'test-model-not-real',model_provider:'fixture'}},
 ...['system','developer'].map(role=>({type:'response_item',payload:{type:'message',role,content:[{type:'input_text',text:'OMIT_'+role.toUpperCase()}]}})),
 {type:'response_item',payload:{type:'message',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'OMIT_REASONING'}]}},
 {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'请检查测试项目。password = "fixture-not-real-123"'}]}},
 {type:'response_item',payload:{type:'message',role:'assistant',channel:'final',content:[{type:'output_text',text:'已完成合成测试。\n'.repeat(600)+'VISIBLE_TAIL'}]}}];
 await writeFile(path.join(workspace,'exam.jsonl'),lines.map(x=>JSON.stringify(x)).join('\n'));
 await writeFile(path.join(workspace,'unrelated.jsonl'),JSON.stringify({type:'session_meta',payload:{cwd:'/unrelated/project'}}));
 await writeFile(path.join(root,'outside.txt'),'NEVER_READ_OUTSIDE');await symlink(path.join(root,'outside.txt'),path.join(workspace,'linked.txt'));
 await writeFile(path.join(workspace,'cursor-export.txt'),'[USER]\n请测试本次项目。\n[ASSISTANT]\nCursor 已完成测试。');
 await writeFile(path.join(workspace,'state.vscdb'),'unsupported synthetic database');
 const startBridge=async()=>{
  const c=new Client({name:'actual-npx-client',version:'1.0'});
  await c.connect(new StdioClientTransport({command:'npx',args:['-y',base+'/downloads/context-bridge-0.1.1.tgz'],env:{PATH:process.env.PATH,HOME:process.env.HOME,ASSESSMENT_URL:base,ASSESSMENT_MCP_TOKEN:token,ASSESSMENT_WORKSPACE:workspace},stderr:'pipe'}),{timeout:90000});return c;
 };
 bridge=await startBridge();
 await check('Published npx package starts and exposes all seven tools',async()=>{
  assert.deepEqual((await bridge.listTools()).tools.map(t=>t.name).sort(),['exam_status','find_candidate_files','prepare_local_bundle','preview_bundle_file','request_upload_approval','submit_approved_materials','test_connection']);
 });
 await check('test_connection and exam_status reach the real public backend',async()=>{
  assert.equal((await call(bridge,'test_connection')).ok,true);
  assert.equal((await call(bridge,'exam_status')).enrollment.mcpConnected,true);
 });
 enrollment=(await user(`/api/enrollments/${enrollment.id}/start`,'POST',{confirmed:true,expectedDurationHours:24})).enrollment;
 const preview=(await user(`/api/enrollments/${enrollment.id}/repository/preview`,'POST',{url:'https://github.com/octocat/Hello-World'})).preview;
 enrollment=(await user(`/api/enrollments/${enrollment.id}/repository/confirm`,'POST',{previewId:preview.id})).enrollment;
 await check('Discovery excludes unrelated sessions and symlink targets',async()=>{
  const f=await call(bridge,'find_candidate_files');assert.equal(f.candidates.length,1);
  assert.equal(JSON.stringify(f).includes(root),false);
  const bad=await call(bridge,'find_candidate_files',{explicitPaths:[path.join(root,'outside.txt'),path.join(workspace,'linked.txt'),path.join(workspace,'state.vscdb')]});assert.equal(bad.candidates.length,0);assert.equal(bad.unsupported.length,3);
 });
 const found=await call(bridge,'find_candidate_files',{explicitPaths:['exam.jsonl','cursor-export.txt']});assert.equal(found.candidates.length,2);
 let bundle,contents=[];
 await check('Codex and selected Cursor export prepare locally without upload',async()=>{
  bundle=await call(bridge,'prepare_local_bundle',{fileIds:found.candidates.map(f=>f.id),repoSha:preview.sha,projectSummary:'MCP 专项验收；全部为合成文件。',collaborationSummary:'模拟用户提出任务，模拟助手完成实现。'});
  assert.equal(bundle.upload,false);assert.equal(bundle.fileCount,2);assert.equal((await user(`/api/enrollments/${enrollment.id}`)).enrollment.materials,null);
 });
 await check('Full paginated preview excludes prompts, reasoning and fake password',async()=>{
  let pages=0;
  for(const f of bundle.files){let offset=0,text='';do{const p=await call(bridge,'preview_bundle_file',{fileName:f.name,offset,limit:1000});assert.equal(p.upload,false);text+=p.text;offset=p.nextOffset;pages++;}while(offset!==null);
   assert.equal(sha(text),f.sha256);assert.equal(Buffer.byteLength(text),f.bytes);contents.push({name:f.name,content:text});
  }
  const all=contents.map(f=>f.content).join('\n');assert.ok(pages>2);assert.ok(all.includes('VISIBLE_TAIL'));assert.ok(all.includes('Cursor 已完成测试'));
  for(const x of ['OMIT_SYSTEM','OMIT_DEVELOPER','OMIT_REASONING','fixture-not-real-123'])assert.equal(all.includes(x),false);
  assert.ok(bundle.files.some(f=>f.redactions>0));
 });
 payload={schemaVersion:1,repoSha:preview.sha,manifest:{files:bundle.files.map(({name,sha256,bytes,source,coverage})=>({name,sha256,bytes,source,coverage})),clients:bundle.clients,projectSummary:bundle.projectSummary,collaborationSummary:bundle.collaborationSummary},files:contents};
 assert.equal(sha(canonical(payload)),bundle.payloadHash);
 approval=await call(bridge,'request_upload_approval');
 await check('Approval request stores metadata only; no transcript uploaded',async()=>{
  assert.equal(approval.contentsSent,false);assert.equal(approval.payloadHash,bundle.payloadHash);assert.equal((await user(`/api/enrollments/${enrollment.id}`)).enrollment.materials,null);
 });
 await check('Upload denied before real approval, even with websiteApproved=true',async()=>{
  await assert.rejects(()=>call(bridge,'submit_approved_materials',{approvalId:approval.approvalId,websiteApproved:true}));
  await assert.rejects(()=>call(bridge,'submit_approved_materials',{approvalId:approval.approvalId,websiteApproved:false}));
  await other(`/api/enrollments/${enrollment.id}/approvals/${approval.approvalId}/approve`,'POST',{approved:true},[403,404]);
 });
 await writeFile(path.join(out,'browser-stage.json'),JSON.stringify({approvalUrl:approval.approvalUrl,enrollmentId:enrollment.id,approvalId:approval.approvalId,fileCount:2,payloadHash:bundle.payloadHash}));
 console.log('WAITING_BROWSER_APPROVAL',approval.approvalUrl);
 let approved=false;
 for(let i=0;i<180;i++){const e=(await user(`/api/enrollments/${enrollment.id}`)).enrollment;if(e.approvals.find(a=>a.id===approval.approvalId)?.state==='APPROVED'){approved=true;break;}await new Promise(r=>setTimeout(r,2000));}
 assert.ok(approved,'Browser approval was not completed within six minutes');
 mcp=await remote(token);
 await check('Tampered content rejected after approval',async()=>{await assert.rejects(()=>call(mcp,'submit_materials',{approvalId:approval.approvalId,payload:{...payload,files:[{...contents[0],content:contents[0].content+'tampered'},contents[1]]}}));});
 let receipt;
 await check('Approved upload stores the exact preview; retry keeps one receipt',async()=>{
  const a=await call(bridge,'submit_approved_materials',{approvalId:approval.approvalId,websiteApproved:true});
  const b=await call(bridge,'submit_approved_materials',{approvalId:approval.approvalId,websiteApproved:true});
  assert.equal(a.upload,true);assert.equal(a.receipt.receipt.id,b.receipt.receipt.id);receipt=a.receipt.receipt;
  const stored=await user(`/api/enrollments/${enrollment.id}/materials`);assert.deepEqual(stored.payload,payload);
  await other(`/api/enrollments/${enrollment.id}/materials`,'GET',undefined,[403,404]);
 });
 await check('MCP upload does not finalize the exam',async()=>{assert.equal((await call(bridge,'exam_status')).enrollment.state,'ACTIVE');});
 await bridge.close();bridge=await startBridge();
 await check('Bridge restart retains remote receipt but does not upload old local state',async()=>{
  assert.equal((await call(bridge,'exam_status')).enrollment.materials.id,receipt.id);
  await assert.rejects(()=>call(bridge,'submit_approved_materials',{approvalId:approval.approvalId,websiteApproved:true}));
 });
 await user(`/api/enrollments/${enrollment.id}/finalize`,'POST',{repositoryId:enrollment.repository.id,materialsId:receipt.id,confirmed:true});
 await check('Finalization revokes MCP access and rejects later material preparation',async()=>{
  assert.equal((await user(`/api/enrollments/${enrollment.id}`)).enrollment.state,'FINALIZED');
  await assert.rejects(()=>call(bridge,'exam_status'));
  await assert.rejects(()=>call(mcp,'prepare_materials',{manifest:payload.manifest,payloadHash:bundle.payloadHash,repoSha:preview.sha}));
 });
 await writeFile(path.join(out,'result.json'),JSON.stringify({ok:true,package:'0.1.1',checkedAt:new Date().toISOString(),checks,enrollmentId:enrollment.id,receiptId:receipt.id},null,2));
 console.log('COMPLETE',checks.length,'checks');
}finally{
 for(const c of [bridge,mcp,old])await c?.close().catch(()=>{});
 if(batch)await admin(`/api/admin/batches/${batch.id}`,'PATCH',{status:'DRAFT'});
 if(root)await rm(root,{recursive:true,force:true});
}
