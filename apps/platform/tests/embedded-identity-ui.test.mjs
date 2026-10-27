import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {runInNewContext} from 'node:vm';
const source=await readFile(new URL('../src/identity.js',import.meta.url),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));
function harness(signedIn=true){const nodes=new Map(),requests=[],messages=[],navigations=[],events={};
 const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,textContent:'',addEventListener:(event,fn)=>{nodes.get(id)[event]=fn;},setAttribute(){},removeAttribute(){}});return nodes.get(id);};
 const location={pathname:'/auth/embedded',search:'?audience=requirements&state='+('s'.repeat(43))+'&code_challenge='+('v'.repeat(43))+'&redirect_uri='+encodeURIComponent('https://makit.110-lab.cn/callback/110lab_requirements/embedded'),replace:url=>navigations.push(url),assign:url=>navigations.push(url)};
 const window={parent:{postMessage:m=>messages.push(m)},addEventListener:(e,f)=>events[e]=f};
 const fetch=async(path,options)=>{requests.push({path,options});let status=200,value={};const name=path.split('/').at(-1);
  if(name==='config')value={enabled:true,services:{requirements:{name:'Makit',federated:true}}};
  if(name==='validate')value={name:'Makit',scopes:[{label:'姓名'}]};
  if(name==='session'){status=signedIn?200:401;value={name:'Fixture',csrf:'fake-csrf'};}
  if(name==='continuation')value={automatic:false};
  if(name==='authorize')value={redirectUrl:'https://makit.110-lab.cn/callback/110lab_requirements/embedded?state='+('s'.repeat(43))+'&iss=https%3A%2F%2Finternal.110-lab.cn&code='+('c'.repeat(43))};
  return {ok:status===200,status,json:async()=>value};};
 runInNewContext(source,{document:{getElementById:node},window,location,fetch,URL,URLSearchParams,AbortSignal});
 return {node,requests,messages,navigations,events,window,signIn:()=>signedIn=true};
}
test('embedded identity waits for user consent and navigates only to the exact callback',async()=>{const h=harness();await flush();assert.equal(h.navigations.length,0);assert.ok(h.requests.every(r=>r.path.startsWith('/api/identity/embedded/')));await h.node('continue').click();await flush();assert.equal(h.navigations.length,1);assert.ok(h.requests.find(r=>r.path.endsWith('/authorize')).options.headers['X-CSRF-Token']);});
test('missing embedded session returns to workbench without opening a forbidden auth page and refreshes on reactivation',async()=>{const h=harness(false);await flush();assert.equal(h.node('button-label').textContent,'返回工作台登录');await h.node('continue').click();await flush();assert.equal(h.messages[0].id,'workbench');assert.equal(h.navigations.length,0);assert.ok(!h.requests.some(r=>r.path.endsWith('/login')));h.signIn();h.events.message({source:{},data:{type:'110lab-workspace-activated'}});await flush();assert.equal(h.node('button-label').textContent,'返回工作台登录');h.events.message({source:h.window.parent,data:{type:'110lab-workspace-activated'}});await flush();assert.equal(h.node('button-label').textContent,'继续前往Makit');});
