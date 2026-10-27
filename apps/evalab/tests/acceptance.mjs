import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { solveChallenge } = require('altcha-lib');
const { deriveKey } = require('altcha-lib/algorithms/pbkdf2');
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.env.TEST_ORIGIN || 'http://127.0.0.1:5380';
const mail = process.env.TEST_MAILPIT || 'http://127.0.0.1:5382';
const results = [];
const existingCandidates = process.env.TEST_CANDIDATES_JSON ? JSON.parse(process.env.TEST_CANDIDATES_JSON) : null;
assert.ok(base.startsWith('http://127.0.0.1:') || existingCandidates, 'Non-local tests require explicitly provisioned test candidates');
const canonical = x => JSON.stringify(sort(x));
function sort(x) { return Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k,sort(x[k])])) : x; }
const hash = x => createHash('sha256').update(x).digest('hex');
const pause = ms => new Promise(r => setTimeout(r,ms));
function session() {
  let cookie = '', csrf = '';
  return async (path, method = 'GET', body, expected = 200) => {
    const res = await fetch(base + path, {method, headers: {'Content-Type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})}, body:body === undefined ? undefined : JSON.stringify(body)});
    for (const item of res.headers.getSetCookie()) { const pair=item.split(';')[0]; const key=pair.split('=')[0]; cookie=cookie.split('; ').filter(p=>p && p.split('=')[0]!==key).concat(pair).join('; '); }
    const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
    if (json.csrfToken) csrf = json.csrfToken;
    assert.ok(Array.isArray(expected)?expected.includes(res.status):res.status===expected, `${method} ${path}: ${res.status}, ${JSON.stringify(json).slice(0,300)}`);
    return json;
  };
}
async function check(name,fn) { await fn();results.push(name);console.log('PASS', name); }
async function register(api,index) {
  if(existingCandidates) {
    const account=existingCandidates[index-1];
    await api('/api/auth/login','POST',{account:account.email,password:account.password});
    return account;
  }
  const email = `assessment-${Date.now()}-${index}@example.test`;
  const challenge = await api('/api/auth/registration-challenge?email='+encodeURIComponent(email));
  const solution = await solveChallenge({challenge,deriveKey,timeout:60000});
  assert.ok(solution,'registration verification');
  const registrationProof=Buffer.from(JSON.stringify({challenge,solution})).toString('base64');
  const ch = await api('/api/auth/email-code','POST',{email,purpose:'REGISTER',registrationProof},[200,201,202]);
  let code;
  for(let i=0;i<35;i++) {
    const list = await fetch(mail+'/api/v1/messages').then(r=>r.json());
    const msg = list.messages?.find(m=>m.To?.some(t=>t.Address === email));
    if(msg) {
      const detail = await fetch(mail+'/api/v1/message/'+msg.ID).then(r=>r.json());
      code = String(detail.Text || detail.HTML).match(/\b\d{6}\b/)?.[0];
      if(code) break;
    }
    await pause(500);
  }
  assert.ok(code,'SMTP outbox must deliver a verification code to local Mailpit');
  const studentNo = `2026${String(Date.now()).slice(-5)}${index}`;
  await api('/api/auth/register','POST',{name:`验收候选人${index}`,studentNo,college:'计算机科学与技术学院',major:'软件工程',phone:'13800138000',email,password:'Test-only-Aa123456!',challengeId:ch.challengeId,code,acceptedPolicy:true},[200,201]);
  return {email,studentNo};
}
async function mcpConnect(token) {
 const client = new Client({name:'110lab-acceptance',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
 return client;
}
async function tool(client,name,args={}) {
 const r=await client.callTool({name,arguments:args});
 const text=r.content?.find(x=>x.type==='text')?.text;
 if(r.isError) throw new Error(text||'MCP failed');
 return r.structuredContent || JSON.parse(text);
}

const admin=session(), user=session(), other=session(), guest=session();
let enrollment, second, question, mcp, token, originalToken, preview, materials, batch;
try {
 await check('API and PostgreSQL health',async()=>assert.equal((await guest('/api/health')).status,'ok'));
 await check('Admin login uses real cookie session',async()=>{
  assert.ok(process.env.TEST_ADMIN_EMAIL && process.env.TEST_ADMIN_PASSWORD,'Test admin credentials required');
  const r=await admin('/api/auth/login','POST',{account:process.env.TEST_ADMIN_EMAIL,password:process.env.TEST_ADMIN_PASSWORD});assert.equal(r.user.role,'ADMIN');
 });
 await check(existingCandidates ? 'Isolated provisioned candidate login' : 'Email verification + candidate registration',async()=>{await register(user,1);await register(other,2);});
 await check('Candidate cannot read operations endpoints',async()=>{await user('/api/admin/overview','GET',undefined,403);await guest('/api/admin/overview','GET',undefined,401);});
 let round;
 await check('Operations creates round, batch and question',async()=>{
  round=(await admin('/api/admin/rounds','POST',{name:`${existingCandidates?'部署验收':'本地验收'}-${Date.now()}`},[200,201])).round;
  batch=(await admin('/api/admin/batches','POST',{roundId:round.id,name:'双通道交卷验收',description:'自动化测试专用',opensAt:new Date(Date.now()-60000).toISOString(),startClosesAt:new Date(Date.now()+86400000).toISOString(),durationHours:24,status:'OPEN'},[200,201])).batch;
  question=(await admin('/api/admin/questions','POST',{batchId:batch.id,direction:'DEVELOPMENT_TEST',title:'验收任务题目',content:'请完成一个可运行项目，并附带测试与使用说明。',published:true,attachmentIds:[]},[200,201])).question;
 });
 await check('One enrollment per round',async()=>{
  enrollment=(await user('/api/enrollments','POST',{batchId:batch.id,direction:'DEVELOPMENT_TEST'},[200,201])).enrollment;
  await user('/api/enrollments','POST',{batchId:batch.id,direction:'PRODUCT'},[200,201,409]);
  // If endpoint is idempotent, enrollment may be unchanged. Reset before start explicitly.
  enrollment=(await user(`/api/enrollments/${enrollment.id}`,'PATCH',{direction:'DEVELOPMENT_TEST'})).enrollment;
  second=(await other('/api/enrollments','POST',{batchId:batch.id,direction:'DEVELOPMENT_TEST'},[200,201])).enrollment;
 });
 await check('Question is hidden before start; cross-user access denied',async()=>{
  assert.equal(enrollment.question,null);await other(`/api/enrollments/${enrollment.id}`,'GET',undefined,[403,404]);
  await user(`/api/enrollments/${enrollment.id}/start`,'POST',{confirmed:true,expectedDurationHours:24},[400,403,409,422]);
 });
 await check('Consent and real MCP protocol preflight',async()=>{
  await user(`/api/enrollments/${enrollment.id}/consent`,'POST',{version:'assessment-consent-v1',accepted:true});
  token=(await user(`/api/enrollments/${enrollment.id}/mcp-token`,'POST',{})).token;originalToken=token;
  mcp=await mcpConnect(token);const tools=await mcp.listTools();assert.ok(tools.tools.some(t=>t.name==='prepare_materials'));
  await tool(mcp,'test_connection');
 });
 await check('Concurrent starts preserve one question and one 24h clock',async()=>{
  const rr=await Promise.all(Array.from({length:5},()=>user(`/api/enrollments/${enrollment.id}/start`,'POST',{confirmed:true,expectedDurationHours:24})));
  assert.equal(new Set(rr.map(r=>r.enrollment.startedAt)).size,1);assert.equal(new Set(rr.map(r=>JSON.stringify(r.enrollment.question))).size,1);
  enrollment=rr[0].enrollment;assert.equal(new Date(enrollment.deadline)-new Date(enrollment.startedAt),86400000);assert.equal(enrollment.question.title,question.title);
 });
 await check('Started direction and snapshot are immutable',async()=>{
  await user(`/api/enrollments/${enrollment.id}`,'PATCH',{direction:'PRODUCT'},[400,409]);
  await admin(`/api/admin/questions/${question.id}`,'PATCH',{batchId:batch.id,direction:'DEVELOPMENT_TEST',title:'运营修改的新题干',content:'更新版本',published:true,attachmentIds:[]});
  assert.equal((await user(`/api/enrollments/${enrollment.id}`)).enrollment.question.title,question.title);
 });
 await check('Repository URL rejects unsafe targets and credentials',async()=>{
  for(const url of ['http://127.0.0.1/a/b','https://user:password@github.com/a/b','https://github.com.evil.test/a/b','https://github.com/a/b/../../x']) await user(`/api/enrollments/${enrollment.id}/repository/preview`,'POST',{url},[400,422]);
 });
 await check('Repository provider preview and exact SHA lock',async()=>{
  preview=(await user(`/api/enrollments/${enrollment.id}/repository/preview`,'POST',{url:'https://github.com/octocat/Hello-World'})).preview;
  assert.match(preview.sha,/^[a-f0-9]{40,64}$/);enrollment=(await user(`/api/enrollments/${enrollment.id}/repository/confirm`,'POST',{previewId:preview.id})).enrollment;
  assert.equal(enrollment.repository.sha,preview.sha);
 });
 const content='用户：请为本次考核项目编写测试。\n助手：已新增单元测试并检查边界条件。';
 const manifest={files:[{name:'exam-conversation.txt',sha256:hash(content),bytes:Buffer.byteLength(content),source:'candidate-export',coverage:'partial'}],clients:[{name:'acceptance-client',models:[{name:'unknown',source:'unknown'}]}],projectSummary:'本次仅验收提交链路。',collaborationSummary:'用户确定需求，Agent 辅助实现与测试。'};
 let payload,approval;
 await check('MCP prepare sends metadata; upload blocked until browser approval',async()=>{
  payload={schemaVersion:1,repoSha:preview.sha,manifest,files:[{name:'exam-conversation.txt',content}]};
  approval=await tool(mcp,'prepare_materials',{manifest,payloadHash:hash(canonical(payload)),repoSha:preview.sha});
  await assert.rejects(()=>tool(mcp,'submit_materials',{approvalId:approval.approvalId,payload}));
  await other(`/api/enrollments/${enrollment.id}/approvals/${approval.approvalId}/approve`,'POST',{approved:true},[403,404]);
 });
 await check('Approved content hash enforced; successful receipt retry is idempotent',async()=>{
  await user(`/api/enrollments/${enrollment.id}/approvals/${approval.approvalId}/approve`,'POST',{approved:true});
  await assert.rejects(()=>tool(mcp,'submit_materials',{approvalId:approval.approvalId,payload:{...payload,files:[{name:'exam-conversation.txt',content:content+' changed'}]}}));
  const a=await tool(mcp,'submit_materials',{approvalId:approval.approvalId,payload});
  const b=await tool(mcp,'submit_materials',{approvalId:approval.approvalId,payload});assert.equal(a.receipt.id,b.receipt.id);materials=a.receipt;
 });
 await check('Candidate inspects uploaded data; other candidate cannot read it',async()=>{
  const r=await user(`/api/enrollments/${enrollment.id}/materials`);assert.equal(r.payload.files[0].content,content);await other(`/api/enrollments/${enrollment.id}/materials`,'GET',undefined,[403,404]);
 });
 await check('Local stdio bridge discovers only exam fixture and completes approved upload',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'lab110-bridge-e2e-'));
  const bridge=new Client({name:'local-bridge-acceptance',version:'1.0.0'});
  try {
   const fixture=[{type:'session_meta',payload:{cwd:root,cli_version:'test-fixture'}},
    {type:'response_item',payload:{type:'message',role:'system',content:[{type:'input_text',text:'OMIT_SYSTEM'}]}},
    {type:'response_item',payload:{type:'message',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'OMIT_INTERNAL'}]}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'请测试本次考核项目。password = "fixture-secret-123"'}]}},
    {type:'response_item',payload:{type:'message',role:'assistant',channel:'final',content:[{type:'output_text',text:'已检查关键功能和边界条件。'}]}}];
   await writeFile(path.join(root,'exam-session.jsonl'),fixture.map(x=>JSON.stringify(x)).join('\n'));
   await bridge.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('context-bridge/dist/index.js')],env:{...process.env,ASSESSMENT_URL:base,ASSESSMENT_MCP_TOKEN:token,ASSESSMENT_WORKSPACE:root,ASSESSMENT_CONTEXT_ROOTS:JSON.stringify([root])},stderr:'pipe'}));
   await tool(bridge,'test_connection');
   const found=await tool(bridge,'find_candidate_files');assert.equal(found.candidates.length,1);
   const bundle=await tool(bridge,'prepare_local_bundle',{fileIds:[found.candidates[0].id],repoSha:preview.sha,projectSummary:'自动化验收专用项目',collaborationSummary:'用户确定目标，Agent 辅助完成测试。'});
   const local=await tool(bridge,'preview_bundle_file',{fileName:bundle.files[0].name});
   for(const hidden of ['OMIT_SYSTEM','OMIT_INTERNAL','fixture-secret-123']) assert.equal(local.text.includes(hidden),false);
   const digest=await tool(bridge,'request_upload_approval');
   assert.equal(new URL(digest.approvalUrl).pathname,`/recruitment/exam/${enrollment.id}`);
   await assert.rejects(()=>tool(bridge,'submit_approved_materials',{approvalId:digest.approvalId,websiteApproved:true}));
   await user(`/api/enrollments/${enrollment.id}/approvals/${digest.approvalId}/approve`,'POST',{approved:true});
   await tool(bridge,'submit_approved_materials',{approvalId:digest.approvalId,websiteApproved:true});
   const stored=await user(`/api/enrollments/${enrollment.id}/materials`);materials=stored.receipt;
   assert.equal(stored.payload.files[0].content,local.text);assert.ok(materials.id);
  } finally {await bridge.close();await rm(root,{recursive:true,force:true});}
 });
 await check('Explicit finalization locks both channels with stable receipt',async()=>{
  const body={repositoryId:enrollment.repository.id,materialsId:materials.id,confirmed:true};
  const a=await user(`/api/enrollments/${enrollment.id}/finalize`,'POST',body);const b=await user(`/api/enrollments/${enrollment.id}/finalize`,'POST',body);
  assert.equal(a.enrollment.state,'FINALIZED');assert.deepEqual(a.receipt,b.receipt);
  await user(`/api/enrollments/${enrollment.id}/repository/preview`,'POST',{url:'https://github.com/octocat/Hello-World'},[400,403,409]);
  await assert.rejects(()=>tool(mcp,'prepare_materials',{manifest,payloadHash:hash(canonical(payload)),repoSha:preview.sha}));
 });
 await check(existingCandidates ? 'Unpublished review stays private' : 'Unpublished review private; publish reveals result',async()=>{
  await admin(`/api/admin/enrollments/${enrollment.id}/review`,'POST',{score:88,feedback:'功能完成，边界校验通过。'});
  assert.equal((await user(`/api/enrollments/${enrollment.id}`)).enrollment.result,null);
  if(existingCandidates) return; // Do not email synthetic candidates from the production provider.
  await admin(`/api/admin/enrollments/${enrollment.id}/publish`,'POST',{});assert.equal((await user(`/api/enrollments/${enrollment.id}`)).enrollment.result.score,88);
 });
 await check('Export and audit available to operations',async()=>{assert.equal(typeof await admin('/api/admin/export'),'string');assert.ok((await admin('/api/admin/audit')).events.length>0);});
 console.log(JSON.stringify({ok:true,checks:results.length,enrollmentId:enrollment.id},null,2));
} finally { if(mcp) await mcp.close(); if(existingCandidates && batch) await admin(`/api/admin/batches/${batch.id}`,'PATCH',{status:'DRAFT'}); }
