import test from 'node:test';
import assert from 'node:assert/strict';
import {createGithubPublicSource,githubRepository} from '../packages/code-sources/github-public.mjs';
import {HEAD,NEXT_HEAD,REPO,repository,pr,payload,response,fixtureFetch} from './fixtures/public-code.mjs';
const input={number:7,headSha:HEAD,repositoryId:'123'};
function source(options={}){return createGithubPublicSource({enabled:()=>true,fetchImpl:fixtureFetch,...options});}
const path=url=>new URL(url).pathname+new URL(url).search;

test('default off, no link and unsupported destinations never call network',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw Error('unexpected');};
  const off=createGithubPublicSource({fetchImpl});assert.deepEqual(await off.summary(REPO),{state:'disabled'});off.close();
  const s=source({fetchImpl});assert.equal((await s.summary('')).state,'not_configured');
  for(const url of ['http://github.com/a/b','https://github.com.evil.test/a/b','https://user:secret@github.com/a/b','https://github.com/a/..','https://github.com/a/b?x=1','http://127.0.0.1/x','https://github.com/a/b/c','https://github.com/a/.git'])assert.equal((await s.summary(url)).state,'unsupported',url);
  assert.equal(calls,0);s.close();assert.equal(githubRepository(REPO+'.git').fullName,'example/project');
});
test('explicit public selection, GET only, no credential inheritance, stable references and bounded summary',async()=>{
  const old=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture-do-not-forward';const calls=[];
  const s=source({fetchImpl:async(url,options)=>{calls.push({url,options});return fixtureFetch(url);}});
  try{const r=await s.summary(REPO);assert.equal(r.state,'ready');assert.equal(r.repository.repositoryId,'123');assert.equal(r.pullRequests[0].reference.pullRequestId,'456');
    assert.equal(r.pullRequests[0].headSha,HEAD);assert.equal(calls.length,2);
    for(const {url,options}of calls){assert.equal(new URL(url).origin,'https://api.github.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.ok(!Object.keys(options.headers).some(k=>/authorization|cookie/i.test(k)));}
    assert.ok(!JSON.stringify(calls).includes('fixture-do-not-forward'));
  }finally{if(old===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=old;s.close();}
});
test('concurrent reads coalesce; bounded cache expires and clears on disable',async()=>{
  let enabled=true,clock=100000,calls=0;const s=source({enabled:()=>enabled,now:()=>clock,cacheMs:10,fetchImpl:async url=>{calls++;return fixtureFetch(url);}});
  await Promise.all([s.summary(REPO),s.summary(REPO)]);assert.equal(calls,2);
  assert.equal((await s.summary(REPO)).cached,true);assert.equal(calls,2);
  clock+=11;await s.summary(REPO);assert.equal(calls,4);
  enabled=false;assert.equal((await s.summary(REPO)).state,'disabled');enabled=true;await s.summary(REPO);assert.equal(calls,6);s.close();
});
for(const [name,data,state] of [['private',{...repository,private:true},'restricted'],['unknown visibility',{...repository,visibility:'internal'},'restricted'],['renamed',{...repository,full_name:'example/other'},'repository_moved']])test(name+' repository refuses data',async()=>{
  let calls=0;const s=source({fetchImpl:async()=>{calls++;return response(data);}});assert.equal((await s.summary(REPO)).state,state);assert.equal(calls,1);s.close();
});
for(const [status,expected] of [[301,'repository_moved'],[403,'restricted'],[404,'not_found'],[500,'unavailable']])test('HTTP '+status+' gives explicit source state without raw details',async()=>{
  const s=source({fetchImpl:async()=>response({secret:'private upstream'},status,{Location:'http://127.0.0.1/private'})});const r=await s.summary(REPO);assert.equal(r.state,expected);assert.ok(!JSON.stringify(r).includes('private upstream'));s.close();
});
test('rate limits stop all reads until retry boundary, without loops',async()=>{
  let clock=100000,calls=0;const s=source({now:()=>clock,fetchImpl:async()=>{calls++;return response({},429,{'Retry-After':'120'});}});
  const a=await s.summary(REPO);assert.equal(a.state,'rate_limited');assert.equal(a.retryAfter,120);
  assert.equal((await s.checks(REPO,input)).state,'rate_limited');assert.equal(calls,1);clock+=120001;await s.summary(REPO);assert.equal(calls,2);s.close();
});
test('whole read deadline aborts transport and stops after timeout',async()=>{
  const s=source({timeoutMs:15,fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))});
  // Keep the process alive while the production deadline timer is unreferenced.
  const timer=setTimeout(()=>{},1000);assert.equal((await s.summary(REPO)).state,'timeout');clearTimeout(timer);s.close();
});
test('oversized bodies and invalid shapes fail closed',async()=>{
  for(const result of [response({x:'x'.repeat(1048576)}),response([]),response('no repo')]){const s=source({fetchImpl:async()=>result});assert.equal((await s.summary(REPO)).state,'unavailable');s.close();}
});
test('paging is bounded and presentation fields contain text only',async()=>{
  const s=source({fetchImpl:async url=>path(url).includes('/pulls?')?response([{...pr,title:'<img src=x onerror=alert(1)>\u0000title'}],200,{Link:'<https://api.github.com/next>; rel="next"'}):fixtureFetch(url)});
  const r=await s.summary(REPO);assert.equal(r.partial,true);assert.ok(!r.pullRequests[0].title.includes('\u0000'));assert.equal(r.pullRequests[0].url,REPO+'/pull/7');s.close();
});
test('checks combine both APIs for the exact head; empty is not passed',async()=>{
  const s=source();const r=await s.checks(REPO,input);assert.equal(r.state,'ready');assert.equal(r.outcome,'passed');assert.equal(r.checks.length,2);assert.equal(r.headSha,HEAD);s.close();
  const empty=source({fetchImpl:async url=>path(url).includes('/check-runs?')?response({total_count:0,check_runs:[]}):path(url).includes('/status?')?response({sha:HEAD,total_count:0,statuses:[]}):fixtureFetch(url)});
  assert.equal((await empty.checks(REPO,input)).outcome,'none');empty.close();
});
test('partial, truncated or wrong-SHA checks cannot be labeled passed',async()=>{
  for(const mode of ['failure','truncated','mismatch','unknown']){
    const s=source({fetchImpl:async url=>{const p=path(url);if(p.includes('/status?')){
      if(mode==='failure')return response({},500);
      const data=structuredClone(payload(p));if(mode==='truncated')data.total_count=100;if(mode==='mismatch')data.sha=NEXT_HEAD;if(mode==='unknown')data.statuses[0].state='invented';return response(data);
    }return fixtureFetch(url);}});
    const r=await s.checks(REPO,input);assert.notEqual(r.outcome,'passed');assert.equal(r.state,mode==='unknown'?'ready':'partial');s.close();
  }
});
test('head change before and during reading invalidates old checks',async()=>{
  for(const changeAt of [1,2]){let count=0;const s=source({fetchImpl:async url=>path(url)==='/repos/example/project/pulls/7'&&++count>=changeAt?response({...pr,head:{sha:NEXT_HEAD}}):fixtureFetch(url)});
    const r=await s.checks(REPO,input);assert.equal(r.state,'head_changed');assert.ok(!r.checks);s.close();}
});
test('repository ID, PR repository and inputs are revalidated',async()=>{
  const s=source();assert.equal((await s.checks(REPO,{...input,repositoryId:'999'})).state,'repository_changed');assert.equal((await s.checks(REPO,{...input,headSha:'main'})).state,'invalid_request');s.close();
  const bad=source({fetchImpl:async url=>path(url).includes('/pulls?')?response([{...pr,base:{repo:{id:999}}}]):fixtureFetch(url)});assert.equal((await bad.summary(REPO)).state,'unavailable');bad.close();
});
test('close aborts active reads, clears pending results and refuses new ones',async()=>{
  let entered;const start=new Promise(r=>entered=r);
  const s=source({fetchImpl:async(_url,{signal})=>{entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('abort'))));}});
  const read=s.summary(REPO);await start;s.close();assert.equal((await read).state,'disabled');assert.equal((await s.summary(REPO)).state,'disabled');
});
test('distinct concurrent requests have a global limit',async()=>{
  let entered=0;const s=source({fetchImpl:async(_url,{signal})=>{entered++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('abort'))));}});
  const a=s.summary(REPO),b=s.summary('https://github.com/example/second');assert.equal((await s.summary('https://github.com/example/third')).state,'busy');assert.equal(entered,2);s.close();await Promise.all([a,b]);
});

test('known head changes invalidate the summary so refreshing can recover immediately',async()=>{
 let changed=false;
 const s=source({fetchImpl:async url=>{const p=path(url);if(p.includes('/pulls?'))return response([{...pr,head:{sha:changed?NEXT_HEAD:HEAD}}]);if(p.endsWith('/pulls/7'))return response({...pr,head:{sha:NEXT_HEAD}});return fixtureFetch(url);}});
 assert.equal((await s.summary(REPO)).pullRequests[0].headSha,HEAD);changed=true;
 assert.equal((await s.checks(REPO,input)).state,'head_changed');
 const fresh=await s.summary(REPO);assert.equal(fresh.cached,false);assert.equal(fresh.pullRequests[0].headSha,NEXT_HEAD);s.close();
});
test('PR number cannot change under a requested reference',async()=>{
 const s=source({fetchImpl:async url=>path(url).endsWith('/pulls/7')?response({...pr,number:8}):fixtureFetch(url)});
 assert.equal((await s.checks(REPO,input)).state,'unavailable');s.close();
});
