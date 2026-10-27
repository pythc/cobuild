import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdentityClient} from '../server/identity-client.mjs';
const redirectUri='https://calendar.110-lab.cn/auth/callback',issuer='https://internal.110-lab.cn';
test('integration helper binds callback to issuer, browser flow, PKCE and its expiration before exchanging',async()=>{
 let calls=0,time=Date.now(),sent;const client=createIdentityClient({audience:'calendar',redirectUri,now:()=>time,fetcher:async(_url,options)=>{calls++;sent=JSON.parse(options.body);return new Response(JSON.stringify({issuer,audience:'calendar',tenantKey:'tenant',unionId:'on_test',subject:'tenant:on_test',name:'成员',expiresAt:new Date(time+3600000).toISOString(),token:'t'.repeat(43)}));}});
 const {url,flow}=client.begin(),auth=new URL(url);assert.equal(auth.searchParams.get('audience'),'calendar');assert.equal(auth.searchParams.get('state'),flow.state);assert.ok(auth.searchParams.get('code_challenge'));
 const callback=new URL(redirectUri);callback.search=new URLSearchParams({state:flow.state,code:'c'.repeat(43),iss:issuer});
 for(const value of [callback.href.replace('calendar.','evil.'),callback.href.replace(flow.state,'s'.repeat(43)),callback.href.replace(encodeURIComponent(issuer),encodeURIComponent('https://evil.example')),callback.href+'&state='+flow.state,callback.href+'&error=denied'])await assert.rejects(client.exchange(value,flow));assert.equal(calls,0);
 const profile=await client.exchange(callback.href,flow);assert.equal(profile.subject,'tenant:on_test');assert.equal(sent.verifier,flow.verifier);assert.equal(sent.redirectUri,redirectUri);time+=11*60000;await assert.rejects(client.exchange(callback.href,flow));assert.equal(calls,1);
});
test('integration helper rejects mismatched identity responses and fails closed on unavailable central service',async()=>{
 let wrong=true;const client=createIdentityClient({audience:'calendar',redirectUri,fetcher:async()=>wrong?new Response(JSON.stringify({issuer,audience:'knowledge'})):new Response('{}',{status:503})});await assert.rejects(client.inspect('t'.repeat(43)),/Invalid identity response/);wrong=false;await assert.rejects(client.inspect('t'.repeat(43)),e=>e.status===503);
 assert.throws(()=>createIdentityClient({audience:'calendar',redirectUri:'http://calendar.110-lab.cn/callback'}));
});
