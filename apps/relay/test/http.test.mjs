import test from 'node:test';
import {issueWidgetGrant} from '../integrations/widget-issuer.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes,createHash,createCipheriv} from 'node:crypto';
import {RelayStore} from '../server/store.mjs';

test('private ingress, OAuth PKCE handoff, one-time redemption and durable sessions',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'relay-http-'));
 const store=new RelayStore(directory),key=randomBytes(32);
 writeFileSync(join(directory,'session.key'),key,{mode:0o600});
 const config={publicBase:'https://cobuild.110-lab.cn/relay',tenantKey:'tenant',directory,
  proxyKey:'p'.repeat(43),storageBase:'https://cobuild.110-lab.cn/__relay_chatwoot',
  accessKey:'a'.repeat(43),sourceId:'relay-test',chatId:'oc_test',feishu:{appId:'test',appSecret:'test'},
  makit:{endpoint:'https://native.example.test/openapi/relay-native',appId:'test'},widgetIssuers:{grading:{key:'w'.repeat(43),apps:['grading-internal'],origins:['https://aigrading.110-lab.cn']}},chatwoot:{origin:'http://127.0.0.1:18460',accountId:1,token:'test-access-token',apps:{'grading-internal':{inboxId:1,identifier:'test',hmacToken:'h'.repeat(32),name:'批改系统'}},operators:{}}};
 const cfg=join(directory,'config.json');writeFileSync(cfg,JSON.stringify(config),{mode:0o600});
 const fixture=join(directory,'fetch.mjs');writeFileSync(fixture,`
 globalThis.fetch=async(input,options={})=>{const url=String(input);
 if(url.includes('/api/identity/inspect')){const token=JSON.parse(options.body).token;const code=token==='r'.repeat(43)?401:token==='s'.repeat(43)?503:token==='f'.repeat(43)?403:200;if(code!==200)return new Response(JSON.stringify({error:'identity failure'}),{status:code});}
 if(url.includes('/conversations/'))return new Response(JSON.stringify(url.includes('/messages')?{payload:[{id:101,message_type:1,private:false,created_at:Date.now()/1000,content:'reply'},{id:102,message_type:1,private:true,created_at:Date.now()/1000,content:'note'}]}:{inbox_id:1}));
 if(url.includes('/api/identity/inspect'))return new Response(JSON.stringify({issuer:'https://internal.110-lab.cn',audience:'relay',tenantKey:'tenant',unionId:'on_test',subject:'tenant:on_test',name:'Test',expiresAt:new Date(Date.now()+3600000).toISOString()}));
 if(url.includes('/auth/v3/tenant_access_token/internal'))return new Response(JSON.stringify({code:0,tenant_access_token:'test',expire:7200}));
 throw Error('Unexpected outbound request');};`);
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 let child;
 async function start(){child=spawn(process.execPath,['--import',fixture,'dist/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,RELAY_CONFIG:cfg,RELAY_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let error='';child.stderr.on('data',v=>{error+=v;});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout '+error)),10000);child.stdout.on('data',v=>{if(v.toString().includes('ready')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('startup '+code+' '+error));});});
 }
 async function stop(){if(child?.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
 t.after(async()=>{await stop();store.close();rmSync(directory,{recursive:true,force:true});});
 await start();
 const headers={Host:'cobuild.110-lab.cn','X-Relay-Intranet-Key':config.proxyKey};
 const call=(path,options={})=>new Promise((resolve,reject)=>{
  const req=httpRequest('http://127.0.0.1:'+port+'/relay'+path,{method:options.method||'GET',headers:{...headers,...options.headers}},res=>{
   const parts=[];res.on('data',v=>parts.push(v));res.on('end',()=>resolve(new Response(Buffer.concat(parts),{status:res.statusCode,headers:res.headers})));
  });req.on('error',reject);req.end(options.body);
 });
 assert.equal((await fetch('http://127.0.0.1:'+port+'/relay/')).status,403);
 assert.equal((await call('/',{headers:{Host:'wrong.test'}})).status,421);
 assert.equal((await call('/api/relay/state')).status,401);
 assert.equal((await call('/api/relay/unread')).status,401);
 const page=await call('/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors/);
 const flow=await call('/auth/start');assert.equal(flow.status,303);assert.match(flow.headers.get('location'),/audience=relay/);assert.match(flow.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
 assert.equal((await call('/auth/callback?state=invalid')).status,400);
 const code=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),hash=v=>createHash('sha256').update(v).digest('hex');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(hash(code)));
 const encrypted=Buffer.concat([iv,cipher.update(JSON.stringify({token:'t'.repeat(43),subject:'tenant:on_test'})),cipher.final(),cipher.getAuthTag()]).toString('base64url');
 store.db.prepare('INSERT INTO handoffs VALUES(?,?,?,?)').run(hash(code),createHash('sha256').update(verifier).digest('base64url'),encrypted,Date.now()+60000);
 const post=(data,origin='https://cobuild.110-lab.cn')=>call('/auth/finish-embed',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await post({code,verifier},'https://evil.test')).status,403);
 assert.equal((await post({code,verifier:'w'.repeat(43)})).status,401);
 const result=await post({code,verifier});assert.equal(result.status,200);assert.match(result.headers.get('set-cookie'),/SameSite=None; Partitioned/);
 assert.equal((await post({code,verifier})).status,401);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM sessions').get().n,1);
 await stop();await start();assert.equal(store.db.prepare('SELECT count(*) AS n FROM sessions').get().n,1);
 // A Relay cookie can remain locally valid after its underlying identity grant expires.
 const credential=(token)=>{const sid=randomBytes(32).toString('base64url'),id=hash(sid),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(id));const encrypted=Buffer.concat([iv,c.update(JSON.stringify({token,subject:'tenant:on_test'})),c.final(),c.getAuthTag()]).toString('base64url');store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(id,encrypted,Date.now()+3600000);return {id,cookie:'relay_session='+sid};};
 const expired=credential('r'.repeat(43)),outage=credential('s'.repeat(43)),denied=credential('f'.repeat(43));
 const expiredResult=await call('/api/relay/profile',{headers:{Cookie:expired.cookie}});assert.equal(expiredResult.status,401);const expiredBody=await expiredResult.json();assert.match(expiredBody.message,/重新登录/);assert.equal(expiredBody.loginPath,'/relay/auth/start');assert.equal(store.db.prepare('SELECT 1 FROM sessions WHERE id_hash=?').get(expired.id),undefined);
 const unavailable=await call('/api/relay/profile',{headers:{Cookie:outage.cookie}});assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).loginPath,undefined);assert.ok(store.db.prepare('SELECT 1 FROM sessions WHERE id_hash=?').get(outage.id),'an identity outage must retain the local session');
 const forbidden=await call('/api/relay/profile',{headers:{Cookie:denied.cookie}});assert.equal(forbidden.status,403);assert.equal((await forbidden.json()).loginPath,undefined);
 const widgetVerifier=randomBytes(32).toString('base64url');
 const {grant}=issueWidgetGrant({key:'w'.repeat(43),issuer:'grading',app:'grading-internal',origin:'https://aigrading.110-lab.cn',subject:'student-1',name:'测试学生',challenge:createHash('sha256').update(widgetVerifier).digest('base64url')});
 const widgetPost=()=>call('/auth/widget',{method:'POST',headers:{Origin:'https://cobuild.110-lab.cn','Content-Type':'application/json'},body:JSON.stringify({grant,verifier:widgetVerifier})});
 const accepted=await widgetPost();assert.equal(accepted.status,200);const widgetToken=(await accepted.json()).token;
 assert.equal((await widgetPost()).status,401,'widget grant is single use');
 const auth={Authorization:'RelayWidget '+widgetToken};
 await store.register({id:'cw_1_1',principal:hash('widget:grading:student-1'),app:'grading-internal',remote_id:1,source_id:'x',created_at:new Date().toISOString()},'test');
 await store.register({id:'cw_1_2',principal:'another-student',app:'grading-internal',remote_id:2,source_id:'y',created_at:new Date().toISOString()},'other');
 const unread=await call('/api/relay/unread',{headers:auth});assert.equal(unread.status,200);assert.equal((await unread.json()).count,1);
 const read=(id,messageId)=>call('/api/relay/conversations/'+id+'/read',{method:'POST',headers:{...auth,Origin:'https://cobuild.110-lab.cn','Content-Type':'application/json'},body:JSON.stringify({messageId})});
 assert.equal((await read('cw_1_2','101')).status,404,'other customers cannot acknowledge replies');
 assert.equal((await read('cw_1_1','102')).status,409,'internal note is not a read cursor');
 assert.equal((await read('cw_1_1','999999')).status,409,'cannot acknowledge a fabricated future ID');
 assert.equal((await read('cw_1_1','101')).status,200);
 assert.equal((await (await call('/api/relay/unread',{headers:auth})).json()).count,0);
 assert.equal((await call('/unread.html')).status,200);

 assert.equal((await call("/api/relay/navigation",{headers:auth})).status,403);
 const profile=await call('/api/relay/profile',{headers:auth});assert.equal(profile.status,200);assert.equal((await profile.json()).role,'handler');
 assert.equal((await call('/api/relay/state?view=operator',{headers:auth})).status,403);
 assert.equal((await call('/api/support/members',{headers:auth})).status,403);
 assert.equal((await call('/api/relay/conversations',{method:'POST',headers:{...auth,Origin:'https://cobuild.110-lab.cn','Content-Type':'application/json'},body:JSON.stringify({app:'makit'})})).status,400);
 await stop();await start();assert.equal((await call('/api/relay/profile',{headers:auth})).status,200,'widget session survives restart');
 const logout=await call('/auth/logout',{method:'POST',headers:{Origin:'https://cobuild.110-lab.cn'}});
 assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/relay_embed_session=;/);
});
