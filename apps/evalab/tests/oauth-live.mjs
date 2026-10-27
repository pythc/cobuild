import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const cfg=JSON.parse(await readFile(process.env.TEST_CONFIG_PATH,'utf8'));
const base=cfg.TEST_ORIGIN;
assert.ok(['https://47.109.176.127','http://127.0.0.1:5380'].includes(base));
function session(){const cookies=new Map(); let csrf=''; return async (path,method='GET',body)=>{
 const r=await fetch(new URL(path,base),{method,redirect:'manual',headers:{Origin:base,'Content-Type':'application/json',Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),'X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 for(const c of r.headers.getSetCookie()){const [kv]=c.split(';');const eq=kv.indexOf('=');cookies.set(kv.slice(0,eq),kv.slice(eq+1));}
 if(r.status===302) return {redirect:r.headers.get('location')};
 const data=await r.json(); assert.ok(r.ok,`${method} ${path.split('?')[0]}: ${r.status} ${data.message||data.error||''}`); if(data.csrfToken)csrf=data.csrfToken;return data;
};}
const admin=session(),user=session(),checks=[];let batch,client,transport;
const account=JSON.parse(cfg.TEST_CANDIDATES_JSON)[0];
try {
 await admin('/api/auth/login','POST',{account:cfg.TEST_ADMIN_EMAIL,password:cfg.TEST_ADMIN_PASSWORD});
 await user('/api/auth/login','POST',{account:account.email,password:account.password});
 const round=(await admin('/api/admin/rounds','POST',{name:`远程接入验收-${Date.now()}`})).round;
 batch=(await admin('/api/admin/batches','POST',{roundId:round.id,name:'远程 MCP 接入验收',description:'专用测试',opensAt:new Date(Date.now()-60000).toISOString(),startClosesAt:new Date(Date.now()+7200000).toISOString(),durationHours:24,status:'OPEN'})).batch;
 await admin('/api/admin/questions','POST',{batchId:batch.id,direction:'DEVELOPMENT_TEST',title:'接入流程验收',content:'专用合成测试，不涉及真实考核内容。',published:true,attachmentIds:[]});
 const exam=(await user('/api/enrollments','POST',{batchId:batch.id,direction:'DEVELOPMENT_TEST'})).enrollment;
 await user(`/api/enrollments/${exam.id}/consent`,'POST',{version:'assessment-consent-v1',accepted:true});
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
 if (!process.env.KEEP_TEST_CONNECTION) {
  await user(`/api/enrollments/${exam.id}/connections/${connections[0].id}`,'DELETE');
  await assert.rejects(()=>client.listTools());checks.push('网页撤销后连接立即不可用');
 }
 const result={origin:base,enrollmentId:exam.id,checks};
 await writeFile(process.env.TEST_OUTPUT_PATH,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {
 if(client)await client.close().catch(()=>{});
 if(batch&&!process.env.KEEP_TEST_BATCH) await admin(`/api/admin/batches/${batch.id}`,'PATCH',{status:'DRAFT'}).catch(()=>{});
}
