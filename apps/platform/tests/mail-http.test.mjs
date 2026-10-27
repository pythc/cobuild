import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMailHttp} from '../server/mail-http.mjs';
import {openMailMembershipState} from '../server/mail-membership-state.mjs';
import {fixtureConfig,fixtureIdentity} from './helpers/mail-fixtures.mjs';

const member={subject:'fictional_tenant:on_fixture_member_2026',email:'fictional.member@110-lab.cn',name:'虚构成员'};
const cookie=r=>r.headers.get('set-cookie')?.split(';')[0]||'';
async function harness(options){
  const mail=await createMailHttp(options),server=createServer((req,res)=>mail.handle(req,res,new URL(req.url,'http://localhost').pathname,req.headers.host.split(':')[0]));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  return {mail,async request(path,{method='GET',data,jar='',origin='https://internal.110-lab.cn',host='internal.110-lab.cn',csrf=''}={}){
    return new Promise((resolve,reject)=>{const req=httpRequest(base+path,{method,headers:{Host:host,Cookie:jar,Origin:origin,...(data===undefined?{}:{'Content-Type':'application/json'}),...(csrf?{'X-CSRF-Token':csrf}:{})}},res=>{const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>{const headers=new Headers();for(const [k,v] of Object.entries(res.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);const text=Buffer.concat(parts).toString();resolve({status:res.statusCode,headers,text:async()=>text,json:async()=>JSON.parse(text)});});});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));});
  },async close(){await new Promise(r=>server.close(r));mail.close();}};
}
async function login(h,code,{embedded=false}={}){
  const prefix='/api/mail/'+(embedded?'embedded/':''),start=await h.request(prefix+'auth/start',{method:'POST',data:{}}),s=await start.json(),binding=cookie(start);
  assert.equal(start.status,200);
  const launch=await h.request('/mail/auth/launch?state='+s.state);assert.equal(launch.status,303);assert.equal(new URL(launch.headers.get('location')).origin,'https://accounts.feishu.cn');
  const callback=await h.request('/mail/auth/callback?state='+s.state+'&code='+code,{jar:cookie(launch)});assert.equal(callback.status,200);
  const html=await callback.text(),ticket=html.match(/<code>([-\w]{43})<\/code>/)[1];
  const redeem=await h.request(prefix+'auth/redeem',{method:'POST',data:{state:s.state,ticket},jar:binding});assert.equal(redeem.status,200);
  const jar=cookie(redeem),session=await h.request(prefix+'session',{jar});assert.equal(session.status,200);
  return {jar,...await session.json()};
}
test('mail HTTP enforces verified members, CSRF, fresh authentication, atomic transfer and live revocation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-mail-http-'));let time=Date.now();
  const options={enabled:true,directory,config:fixtureConfig,localTest:true,now:()=>time,fetchIdentity:async(_,{code})=>code==='member'?member:fixtureIdentity};
  let h=await harness(options);
  try{
    const owner=await login(h,'owner'),person=await login(h,'member');
    const request=(actor,kind,email,revision,extra={})=>h.request('/api/organization/administrators/'+kind,{method:'POST',jar:actor.jar,csrf:actor.csrf,data:{email,revision,confirmed:true},...extra});
    const revision=async actor=>(await (await h.request('/api/mail/administrators',{jar:actor.jar})).json()).revision;
    assert.equal(owner.role,'super_admin');assert.equal(person.role,'member');
    for(const path of ['administrators','members','audit'])assert.equal((await h.request('/api/mail/'+path,{jar:person.jar})).status,403);
    const rev=await revision(owner);
    assert.equal((await request(owner,'grant','unknown@110-lab.cn',rev)).status,409);
    assert.equal((await request(owner,'grant',member.email,rev,{csrf:'a'.repeat(43)})).status,403);
    assert.equal((await request(owner,'grant',member.email,rev,{origin:'https://untrusted.example'})).status,403);
    assert.equal((await request(owner,'grant',member.email,rev,{data:{email:member.email,revision:rev,confirmed:false}})).status,400);
    assert.equal((await request(owner,'grant',member.email,rev)).status,200);
    assert.equal((await (await h.request('/api/mail/session',{jar:person.jar})).json()).role,'admin');
    assert.equal((await request(person,'transfer',fixtureIdentity.email,await revision(owner))).status,403);
    assert.equal((await request(owner,'transfer',member.email,rev)).status,409);
    assert.equal((await request(owner,'revoke',fixtureIdentity.email,await revision(owner))).status,403);
    time+=300001;assert.equal((await request(owner,'transfer',member.email,await revision(owner))).status,403);
    const fresh=await login(h,'owner');assert.equal((await request(fresh,'transfer',member.email,await revision(fresh))).status,200);
    assert.equal((await (await h.request('/api/mail/session',{jar:owner.jar})).json()).role,'admin');
    assert.equal((await request(fresh,'grant','unknown@110-lab.cn',3)).status,403);
    const next=await login(h,'member');assert.equal(next.role,'super_admin');
    assert.equal((await request(next,'revoke',fixtureIdentity.email,await revision(next))).status,200);
    assert.equal((await (await h.request('/api/mail/session',{jar:owner.jar})).json()).role,'member');
    const events=await (await h.request('/api/mail/audit',{jar:next.jar})).json();assert.deepEqual(events.events.map(e=>e.action),['revoke','transfer','grant','bootstrap']);
    await h.close();h=await harness(options);
    assert.equal((await (await h.request('/api/mail/session',{jar:next.jar})).json()).role,'super_admin');
    assert.equal((await (await h.request('/api/mail/session',{jar:owner.jar})).json()).role,'member');
    assert.equal((await h.request('/mail',{host:'110-lab.cn'})).status,404);
    assert.equal((await h.request('/api/mail/config',{host:'110-lab.cn'})).status,404);
    const invalidCallback=await h.request('/mail/auth/callback?state=private-invalid-state&code=private-invalid-code');assert.equal(invalidCallback.status,401);assert.match(invalidCallback.headers.get('content-type'),/text\/html/);assert.match(await invalidCallback.text(),/返回工作台/);assert.doesNotMatch(await invalidCallback.text(),/private-invalid/);
    const embeddedPage=await h.request('/mail/embedded');assert.equal(embeddedPage.status,200);assert.match(embeddedPage.headers.get('content-security-policy'),/codex-sandbox:/);assert.doesNotMatch(embeddedPage.headers.get('content-security-policy'),/\*/);
    const allowed=embeddedPage.headers.get('content-security-policy').match(/frame-ancestors ([^;]+)/)[1].split(' ');
    for(const host of ['mcp-app-378d4bef0808dd032fe89b17252aa980ad0e29f3d5ace47c','mcp-app-6231ba4b79ed6a654eda2cd7ee1cca5ff88c1453a659ea27'])assert.ok(allowed.includes(`codex-sandbox://${host}.web-sandbox.oaiusercontent.com`));
    assert.ok(!allowed.includes('codex-sandbox:'));assert.ok(allowed.includes('https://chatgpt.com'));assert.equal(allowed.length,7);
    const embedded=await login(h,'member',{embedded:true});assert.match(embedded.jar,/__Host-110lab_mail_embedded=/);
    assert.equal((await h.request('/api/mail/session',{jar:embedded.jar})).status,401);
    assert.equal((await h.request('/api/mail/embedded/session',{jar:embedded.jar})).status,200);
    assert.equal((await h.request('/api/mail/send',{method:'POST',data:{},jar:next.jar,csrf:next.csrf})).status,404);
  }finally{await h.close();await rm(directory,{recursive:true,force:true});}
});
test('unconfigured mail login fails closed while its page remains available',async()=>{
  const h=await harness({enabled:false});
  try{assert.deepEqual(await (await h.request('/api/mail/config')).json(),{loginAvailable:false,notifyManualSend:false,persistentLoginDays:30,restorePolicy:1});assert.equal((await h.request('/api/mail/auth/start',{method:'POST',data:{}})).status,503);assert.equal((await h.request('/mail')).status,200);assert.match((await h.request('/mail')).headers.get('content-security-policy'),/frame-ancestors 'none'/);}
  finally{await h.close();}
});
test('notify access requires a live administrator and fresh membership verification',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-notify-http-'));let time=Date.now();
  const now=()=>time,h=await harness({enabled:true,notifyEnabled:true,directory,config:fixtureConfig,localTest:true,now,fetchIdentity:async(_,{code})=>code==='member'?member:fixtureIdentity});
  const state=openMailMembershipState({directory,now});
  try{
    const owner=await login(h,'owner'),person=await login(h,'member');
    assert.equal((await h.request('/api/mail/notify')).status,401);
    assert.equal((await h.request('/api/mail/notify',{jar:person.jar})).status,403);
    let status=await (await h.request('/api/mail/notify',{jar:owner.jar})).json();assert.equal(status.state,'pending');assert.equal(status.url,undefined);
    state.claim();state.finish(1);
    status=await (await h.request('/api/mail/notify',{jar:owner.jar})).json();assert.equal(status.state,'ready');assert.equal(status.url,'https://www.feishu.cn/mail');
    const change=async(kind,revision)=>h.request('/api/mail/administrators/'+kind,{method:'POST',jar:owner.jar,csrf:owner.csrf,data:{email:member.email,revision,confirmed:true}});
    const granted=await change('grant',1);assert.equal(granted.status,200);assert.equal((await granted.json()).mailbox.state,'pending');
    status=await (await h.request('/api/mail/notify',{jar:person.jar})).json();assert.equal(status.state,'pending');assert.equal(status.url,undefined);
    state.finish(2);assert.equal((await (await h.request('/api/mail/notify',{jar:person.jar})).json()).state,'ready');
    assert.equal((await change('revoke',2)).status,200);
    assert.equal((await h.request('/api/mail/notify',{jar:person.jar})).status,403);
    state.finish(3);time+=60001;
    status=await (await h.request('/api/mail/notify',{jar:owner.jar})).json();assert.equal(status.state,'pending');assert.equal(status.url,undefined);
  }finally{state.close();await h.close();await rm(directory,{recursive:true,force:true});}
});

test('admin directory grants require a fresh provider member and revalidate auth after lookup',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-directory-grant-'));let members=[{subject:member.subject,name:member.name,email:''}],fail=false,optionsSeen=[],duringLookup;
  const h=await harness({enabled:true,directory,config:fixtureConfig,localTest:true,fetchIdentity:async(_,{code})=>code==='member'?member:fixtureIdentity,fetchDirectory:async options=>{optionsSeen.push(options);if(duringLookup)await duringLookup();if(fail)throw Error('private-provider-error');return members;}});
  try{
    const owner=await login(h,'owner');
    const req=(route,data)=>h.request('/api/mail/'+route,{method:'POST',jar:owner.jar,csrf:owner.csrf,data});
    const grant=(subject,revision=1)=>req('administrators/grant',{subject,revision,confirmed:true});
    const list=await h.request('/api/mail/members',{jar:owner.jar});assert.equal(list.status,200);assert.equal((await list.json()).members[0].subject,member.subject);
    assert.equal((await grant('other_tenant:on_outside_2026')).status,409);
    fail=true;assert.equal((await grant(member.subject)).status,503);assert.equal((await h.request('/api/mail/members',{jar:owner.jar})).status,503);fail=false;
    members=[];assert.equal((await grant(member.subject)).status,409);
    members=[{subject:member.subject,name:member.name,email:''}];
    assert.equal((await grant(member.subject)).status,200);assert.equal(optionsSeen.at(-1).fresh,true);
    const person=await login(h,'member');assert.equal(person.role,'admin');
    assert.equal((await h.request('/api/mail/members',{jar:person.jar})).status,403);
    assert.equal((await req('administrators/revoke',{subject:member.subject,revision:3,confirmed:true})).status,200);
    duringLookup=async()=>{duringLookup=null;await req('logout',{});};
    assert.equal((await grant(member.subject,4)).status,401,'logout during provider request prevents a stale grant');
  }finally{await h.close();await rm(directory,{recursive:true,force:true});}
});

test('organization app shares legacy roles, audit and mailbox membership without broadening access',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-organization-http-'));
  const h=await harness({enabled:true,notifyEnabled:true,directory,config:fixtureConfig,localTest:true,fetchIdentity:async(_,{code})=>code==='member'?member:fixtureIdentity,fetchDirectory:async()=>[fixtureIdentity,member]});
  const state=openMailMembershipState({directory});
  try{
    for(const suffix of ['','/embedded']){
      const result=await h.request('/organization'+suffix);assert.equal(result.status,200);
      const page=await result.text();assert.match(page,/组织与权限/);
      assert.match(page,suffix?/<body class="cb-shell cb-organization embedded">/:/<body class="cb-shell cb-organization">/);
      assert.match(result.headers.get('content-security-policy'),suffix?/frame-ancestors 'self'/ : /frame-ancestors 'none'/);
    }
    const html=await(await h.request('/mail')).text();
    assert.ok(!html.includes('id="grant-form"'));assert.ok(!html.includes('id="admin-list"'));assert.match(html,/邮箱授权/);
    for(const embedded of [false,true]){
      const owner=await login(h,'owner',{embedded}),person=await login(h,'member',{embedded});
      const prefix='/api/organization/'+(embedded?'embedded/':''),old='/api/mail/'+(embedded?'embedded/':'');
      assert.equal((await h.request(prefix+'session',{jar:owner.jar})).status,200);
      assert.equal((await h.request('/api/organization/'+(embedded?'':'embedded/')+'session',{jar:owner.jar})).status,401);
      for(const route of ['administrators','members','audit']){
        assert.equal((await h.request(prefix+route)).status,401);
        assert.equal((await h.request(prefix+route,{jar:person.jar})).status,403);
      }
      const revision=(await(await h.request(prefix+'administrators',{jar:owner.jar})).json()).revision;
      const write=(kind,rev,extra={})=>h.request(prefix+'administrators/'+kind,{method:'POST',jar:owner.jar,csrf:owner.csrf,data:{subject:member.subject,revision:rev,confirmed:true},...extra});
      assert.equal((await write('grant',revision,{csrf:'bad'})).status,403);
      assert.equal((await write('grant',revision,{origin:'https://evil.example'})).status,403);
      assert.equal((await write('grant',revision)).status,200);
      assert.equal(h.mail.profile(member.subject).role,'admin');
      assert.equal((await h.request(prefix+'members',{jar:person.jar})).status,403,'ordinary administrators cannot assign roles');
      const list=await(await h.request(old+'administrators',{jar:owner.jar})).json();
      assert.equal(list.administrators.find(a=>a.subject===member.subject).role,'admin');
      assert.equal((await write('revoke',revision)).status,409,'old and new APIs share one revision');
      const pending=await(await h.request(old+'notify',{jar:person.jar})).json();assert.equal(pending.state,'pending');
      assert.equal(state.claim(),true);state.finish(list.revision);
      assert.equal((await(await h.request(old+'notify',{jar:person.jar})).json()).state,'ready');
      assert.equal((await write('revoke',list.revision)).status,200);
      assert.equal(h.mail.profile(member.subject).role,'member');
      assert.equal((await h.request(old+'notify',{jar:person.jar})).status,403);
      const audit=await(await h.request(prefix+'audit',{jar:owner.jar})).json();
      assert.ok(audit.events.some(e=>e.action==='grant'));assert.ok(audit.events.some(e=>e.action==='revoke'));
    }
    assert.equal((await h.request('/api/organization/send',{method:'POST',data:{}})).status,401);
  }finally{state.close();await h.close();await rm(directory,{recursive:true,force:true});}
});


test('browser login returns to its bound application and shares the unified identity session',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-login-return-'));
  const h=await harness({enabled:true,unifiedIdentityEnabled:true,directory,config:fixtureConfig,localTest:true,fetchIdentity:async()=>fixtureIdentity,fetchDirectory:async()=>[fixtureIdentity]});
  t.after(async()=>{await h.close();await rm(directory,{recursive:true,force:true});});
  for(const returnTo of ['/workbench','/projects','/organization','/mail']){
    const start=await h.request('/api/mail/auth/start',{method:'POST',data:{returnTo}});assert.equal(start.status,200);
    const {state}=await start.json(),launch=await h.request('/mail/auth/launch?state='+state);
    const callback=await h.request('/mail/auth/callback?state='+state+'&code=fixture',{jar:cookie(launch)});
    assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),returnTo);assert.equal(await callback.text(),'');
    const jar=cookie(callback),mail=await(await h.request('/api/mail/session',{jar})).json(),identity=await h.request('/api/identity/session',{jar});
    assert.equal(identity.status,200);assert.equal((await identity.json()).subject,mail.subject);
    assert.equal((await h.request('/api/organization/session',{jar})).status,200);
    assert.equal((await h.request('/mail/auth/callback?state='+state+'&code=fixture',{jar:cookie(launch)})).status,401);
  }
  for(const returnTo of ['https://evil.example','//evil.example','/organization?next=https://evil.example','/mail/auth/callback','/organization\\evil']){
    assert.equal((await h.request('/api/mail/auth/start',{method:'POST',data:{returnTo}})).status,400);
  }
  assert.equal((await h.request('/api/mail/embedded/auth/start',{method:'POST',data:{returnTo:'/organization'}})).status,400);
});


test('OAuth completion and failure use the current unified authentication template',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-identity-result-')),h=await harness({enabled:true,directory,config:fixtureConfig,localTest:true,fetchIdentity:async()=>fixtureIdentity});
  t.after(async()=>{await h.close();await rm(directory,{recursive:true,force:true});});
  const current=await readFile(new URL('../dist/identity.html',import.meta.url),'utf8'),style=current.match(/<style>([\s\S]*?)<\/style>/)[1],brand=current.match(/<header>[\s\S]*?<\/header>/)[0];
  const start=await h.request('/api/mail/auth/start',{method:'POST',data:{}}),{state}=await start.json(),launch=await h.request('/mail/auth/launch?state='+state);
  const success=await h.request('/mail/auth/callback?state='+state+'&code=fixture',{jar:cookie(launch)}),html=await success.text();
  assert.equal(success.status,200);assert.ok(html.includes(style));assert.ok(html.includes(brand));assert.match(html,/<h1 id="title">登录成功<\/h1>/);assert.match(html,/<p class="eyebrow">统一认证<\/p>/);
  assert.match(html,/<details class="identity-handoff">/);assert.doesNotMatch(html,/<details[^>]*\bopen\b|公共邮箱|打开组织与权限/);
  assert.match(html,/<a class="primary" href="\/workbench">返回工作台<\/a>/);assert.match(html,/postMessage\(message,'https:\/\/internal\.110-lab\.cn'\)/);
  assert.ok(html.lastIndexOf('<script>')<html.lastIndexOf('</body>'));assert.match(success.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(success.headers.get('cache-control'),'no-store');
  const ticket=html.match(/<code>([-\w]{43})<\/code>/)[1],redeemed=await h.request('/api/mail/auth/redeem',{method:'POST',data:{state,ticket},jar:cookie(start)});assert.equal(redeemed.status,200);
  assert.equal((await h.request('/api/mail/auth/redeem',{method:'POST',data:{state,ticket},jar:cookie(start)})).status,401);
  const failure=await h.request('/mail/auth/callback?state=fixture-invalid&code=fixture-private'),failed=await failure.text();assert.equal(failure.status,401);assert.ok(failed.includes(style));assert.ok(failed.includes(brand));assert.match(failed,/<h1 id="title">认证未完成<\/h1>/);assert.doesNotMatch(failed,/fixture-private|<code>|公共邮箱|postMessage/);
});
