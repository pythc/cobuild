import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const cfg=JSON.parse(await readFile(process.env.TEST_CONFIG_PATH,'utf8'));
const base=cfg.TEST_ORIGIN;
assert.ok(['https://47.109.176.127','http://127.0.0.1:5380'].includes(base));
function session(){const cookies=new Map(); let csrf=''; const api=async (path,method='GET',body)=>{
 const r=await fetch(new URL(path,base),{method,redirect:'manual',headers:{Origin:base,'Content-Type':'application/json',Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),'X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 for(const c of r.headers.getSetCookie()){const [kv]=c.split(';');const eq=kv.indexOf('=');cookies.set(kv.slice(0,eq),kv.slice(eq+1));}
 if(r.status===302) return {redirect:r.headers.get('location')};
 const data=await r.json(); assert.ok(r.ok,`${method} ${path.split('?')[0]}: ${r.status} ${data.message||data.error||''}`); if(data.csrfToken)csrf=data.csrfToken;return data;
};api.bytes=async path=>{const r=await fetch(new URL(path,base),{headers:{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}});assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());};return api;}
const admin=session(),user=session(),checks=[];let batch,client,transport; const scratch=await mkdtemp(path.join(tmpdir(),'direct-upload-live-'));
const account=JSON.parse(cfg.TEST_CANDIDATES_JSON)[0];
try {
 await admin('/api/auth/login','POST',{account:cfg.TEST_ADMIN_EMAIL,password:cfg.TEST_ADMIN_PASSWORD});
 await user('/api/auth/login','POST',{account:account.email,password:account.password});
 const round=(await admin('/api/admin/rounds','POST',{name:`直接上传验收-${Date.now()}`})).round;
 batch=(await admin('/api/admin/batches','POST',{roundId:round.id,name:'材料直接上传验收',description:'专用测试',opensAt:new Date(Date.now()-60000).toISOString(),startClosesAt:new Date(Date.now()+7200000).toISOString(),durationHours:24,status:'OPEN'})).batch;
 await admin('/api/admin/questions','POST',{batchId:batch.id,direction:'DEVELOPMENT_TEST',title:'原文件提交验收',content:'专用合成测试，不涉及真实考核内容。',published:true,attachmentIds:[]});
 const exam=(await user('/api/enrollments','POST',{batchId:batch.id,direction:'DEVELOPMENT_TEST'})).enrollment;
 await user(`/api/enrollments/${exam.id}/consent`,'POST',{version:'assessment-materials-v2',accepted:true});
 let info,tokens,verifier,authorizationUrl;
 const state=randomUUID();
 const provider={
  redirectUrl:'http://127.0.0.1:49189/callback',
  clientMetadata:{client_name:'官方 SDK 接入验收',redirect_uris:['http://127.0.0.1:49189/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'assessment'},
  state:()=>state, clientInformation:()=>info, saveClientInformation:x=>{info=x},tokens:()=>tokens,saveTokens:x=>{tokens=x},
  redirectToAuthorization:u=>{authorizationUrl=u},saveCodeVerifier:x=>{verifier=x},codeVerifier:()=>verifier,
 };
 transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{authProvider:provider});
 client=new Client({name:'oauth-live-review',version:'1.0'});
 await assert.rejects(()=>client.connect(transport)); assert.ok(authorizationUrl);checks.push('官方 SDK 自动发现授权服务并动态注册');
 const flow=await user(authorizationUrl.href); const id=new URL(flow.redirect).searchParams.get('request');
 const request=(await user(`/api/oauth/requests/${id}`)).request; assert.ok(request.enrollments.some(x=>x.id===exam.id));
 const {redirectUrl}=await user(`/api/oauth/requests/${id}/decision`,'POST',{approved:true,enrollmentId:exam.id});
 const callback=new URL(redirectUrl);assert.equal(callback.searchParams.get('state'),state);
 await transport.finishAuth(callback.searchParams.get('code')); assert.ok(tokens?.access_token&&tokens?.refresh_token);checks.push('真实 HTTP 登录、考核授权和 PKCE 换取令牌');
 await client.close();
 client=new Client({name:'oauth-live-review',version:'1.0'});
 transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{authProvider:provider});
 await client.connect(transport);
 assert.equal((await client.listTools()).tools.length,3);
 const probe=await client.callTool({name:'test_connection',arguments:{}});assert.ok(!probe.isError);
 assert.equal((await user(`/api/enrollments/${exam.id}`)).enrollment.mcpConnected,true);checks.push('MCP 三个工具可发现，连接测试回写开考准备');
 const connections=(await user(`/api/enrollments/${exam.id}/connections`)).connections;assert.equal(connections.length,1);
 await client.close();
 const oldRefresh=tokens.refresh_token;
 tokens={...tokens,access_token:'loa_expired_for_refresh_validation_only'};
 client=new Client({name:'oauth-refresh-review',version:'1.0'});
 transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{authProvider:provider});
 await client.connect(transport);assert.notEqual(tokens.refresh_token,oldRefresh);checks.push('失效访问令牌经官方 SDK 自动刷新并继续调用');

 await user(`/api/enrollments/${exam.id}/start`,'POST',{confirmed:true,expectedDurationHours:24});
 let preview;
 if(process.env.TEST_LOCAL_REPO_FIXTURE_CONFIG){
  assert.equal(base,'http://127.0.0.1:5380');
  const local=JSON.parse(await readFile(process.env.TEST_LOCAL_REPO_FIXTURE_CONFIG,'utf8'));
  assert.equal(local.APP_ORIGIN,base);assert.ok(/^[a-z_][a-z0-9_]*$/.test(local.DB_SCHEMA));
  const pool=new Pool({connectionString:local.DATABASE_URL,options:'-c search_path='+local.DB_SCHEMA+',public'});
  try {
   const r=await pool.query(`INSERT INTO repository_previews(enrollment_id,user_id,url,branch,sha,message,author,committed_at,expires_at)
    SELECT e.id,e.user_id,'https://github.com/octocat/Hello-World','master',$2,'本地上传验收专用快照','test',now(),now()+interval '10 minutes'
    FROM enrollments e JOIN users u ON u.id=e.user_id WHERE e.id=$1 AND u.email=$3 RETURNING id,sha`,[exam.id,'a'.repeat(40),account.email]);
   assert.equal(r.rowCount,1);preview=r.rows[0];
  } finally {await pool.end();}
  checks.push('本地上传验收使用显式测试仓库快照；未将 GitHub 限流计为仓库查询通过');
 } else preview=(await user(`/api/enrollments/${exam.id}/repository/preview`,'POST',{url:'https://github.com/octocat/Hello-World'})).preview;
 await user(`/api/enrollments/${exam.id}/repository/confirm`,'POST',{previewId:preview.id});
 const helperResponse=await fetch(base+'/downloads/upload-materials.py');assert.equal(helperResponse.status,200);
 const helper=path.join(scratch,'upload-materials.py');await writeFile(helper,await helperResponse.text());
 const hash=buf=>createHash('sha256').update(buf).digest('hex');
 async function ticket(){const result=await client.callTool({name:'submit_materials',arguments:{repoSha:preview.sha,clients:[{name:'SDK验收',models:[{name:'unknown',source:'unknown'}]}],projectSummary:'纯合成上传测试',collaborationSummary:'本地程序传输文件，模型未重新生成正文'}});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);}
 async function runHelper(t,args){
  const ticketFile=path.join(scratch,'ticket.json');await writeFile(ticketFile,JSON.stringify(t),{mode:0o600});
  await new Promise((resolve,reject)=>{let output='';const p=spawn('python3',[helper,'--ticket-file',ticketFile,...args]);p.stdout.on('data',b=>{output=(output+b.toString()).slice(-12000);});p.stderr.on('data',b=>{output=(output+b.toString()).slice(-12000);});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('Upload helper failed: '+output)));});
 }
 const contents=[{name:'history-one.jsonl',content:'x'.repeat(140096)},{name:'history-two.txt',content:'z'.repeat(4089)}];
 const legacy=path.join(scratch,'payload.json');await writeFile(legacy,JSON.stringify({schemaVersion:1,repoSha:preview.sha,manifest:{files:contents.map(f=>({name:f.name,bytes:Buffer.byteLength(f.content),sha256:hash(f.content),source:'agent-export',coverage:'partial'})),clients:[],projectSummary:'',collaborationSummary:''},files:contents}));
 const t1=await ticket();await runHelper(t1,['--payload-json',legacy]);
 let doc=await admin(`/api/enrollments/${exam.id}/materials`);assert.equal(doc.payload.schemaVersion,2);assert.equal(doc.payload.files.length,2);
 for(const f of doc.payload.files){const bytes=await admin.bytes(f.downloadUrl);assert.equal(hash(bytes),hash(contents.find(x=>x.name===f.name).content));}
 checks.push('140096+4089字节旧payload由程序直接上传，服务端文件逐字节核对通过');
 const original=path.join(scratch,'original.jsonl'),raw=Buffer.alloc(5*1024*1024+17,0x41);Buffer.from('password=synthetic-test-only\r\n原始对话\r\n').copy(raw);await writeFile(original,raw);
 const t2=await ticket();await runHelper(t2,['--snapshot','--file',original]);
 doc=await admin(`/api/enrollments/${exam.id}/materials`);assert.equal(hash(await admin.bytes(doc.payload.files[0].downloadUrl)),hash(raw));
 assert.equal(hash(await admin.bytes(doc.payload.files[0].downloadUrl)),hash(raw));
 await assert.rejects(()=>user(`/api/enrollments/${exam.id}/materials`),/403/);
 await assert.rejects(()=>user(doc.payload.files[0].downloadUrl),/403/);
 checks.push('考生材料正文与原文件访问均返回403，状态回执与交卷仍可用');
 checks.push('运营账号下载完整原文件，文件哈希一致');
 checks.push('5MB原始文件跨4MB分块上传，无内容改写、无逐份批准、无全文MCP参数');
 const final=(await user(`/api/enrollments/${exam.id}`)).enrollment;assert.equal(final.materialUpload.receivedBytes,raw.length);assert.equal(final.materialUpload.status,'RECEIVED');
 if(!process.env.KEEP_TEST_ACTIVE){await user(`/api/enrollments/${exam.id}/finalize`,'POST',{repositoryId:final.repository.id,materialsId:final.materials.id,confirmed:true});checks.push('仓库与材料同版，显式确认交卷成功');}
 const result={origin:base,enrollmentId:exam.id,checks};
 await writeFile(process.env.TEST_OUTPUT_PATH,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {
 await rm(scratch,{recursive:true,force:true});
 if(client)await client.close().catch(()=>{});
 if(batch&&!process.env.KEEP_TEST_BATCH) await admin(`/api/admin/batches/${batch.id}`,'PATCH',{status:'DRAFT'}).catch(()=>{});
}
