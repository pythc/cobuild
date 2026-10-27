const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
let config,profile,busy=false,ready=false,flowValid=false;
const embedded=location.pathname==='/auth/embedded',api=embedded?'/api/identity/embedded/':'/api/identity/';
function returnToWorkbench(){if(window.parent!==window)window.parent.postMessage({type:'110lab-workspace-open-app',id:'workbench'},'*');else location.assign('/workbench');}
const audience=params.get('audience'),state=params.get('state'),challenge=params.get('code_challenge'),redirectUri=params.get('redirect_uri');
const target=params.get('service')||'workbench',isFlow=!!audience;
const unique=['audience','state','code_challenge','redirect_uri','service'].every(k=>params.getAll(k).length<=1);
const valid=unique&&(!embedded||isFlow)&&(!isFlow||/^[\w-]{43}$/.test(state||'')&&/^[\w-]{43}$/.test(challenge||'')&&!!redirectUri);
const flow={audience,state,challenge,redirectUri};
async function request(path,data){const r=await fetch(api+path,{method:data?'POST':'GET',credentials:'same-origin',redirect:'error',cache:'no-store',headers:data?{'Content-Type':'application/json',...(profile?{'X-CSRF-Token':profile.csrf}:{})}:{},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(10000)});const v=await r.json();if(!r.ok)throw Object.assign(new Error(v.error||'暂时无法继续，请重试'),{status:r.status});return v;}
function message(text){$('status').hidden=!text;$('status').textContent=text;}
function service(){return Object.hasOwn(config?.services||{},audience||target)?config.services[audience||target]:null;}
function paint(){const app=service();$('profile').hidden=!profile;$('avatar').hidden=!profile?.avatarUrl;if(profile?.avatarUrl)$('avatar').src=profile.avatarUrl;else $('avatar').removeAttribute('src');
  if(profile){$('name').textContent=profile.name;$('email').textContent=profile.email||'';}
  $('subtitle').textContent=profile?'已登录，可以继续。':'使用飞书账号继续。';
  $('app-name').textContent=app?.name||'工作台';$('app-icon').src='/assets/icons/'+(app?.icon==='home'?'identity-home':app?.icon||'apps')+'.svg';
  $('footnote').textContent='登录后返回'+(app?.name||'工作台')+'。';
  $('button-label').textContent=busy?'正在连接…':!ready?'重新连接':profile?'继续前往'+app?.name:embedded?'返回工作台登录':'使用飞书登录';
  $('continue').disabled=busy||(!valid)||(ready&&(!config?.enabled||!flowValid));$('change').disabled=busy;
  $('continue').setAttribute('aria-busy',String(busy));
}
async function login(){const v=await request('login',{next:'/auth'+location.search});const u=new URL(v.launchUrl);if(u.origin!=='https://internal.110-lab.cn'||u.pathname!=='/mail/auth/launch')throw new Error('登录地址无效');location.assign(u.href);}
async function continueLogin(force=false){if(busy)return;if(!ready)return initialize();busy=true;paint();message('');try{if(embedded&&(force||!profile)){returnToWorkbench();busy=false;paint();return;}if(force&&profile){await request('logout',{});profile=undefined;}if(!profile||force)return await login();if(isFlow){const v=await request('authorize',flow);const u=new URL(v.redirectUrl),expected=new URL(redirectUri);if(u.origin!==expected.origin||u.pathname!==expected.pathname||u.searchParams.get('state')!==state||u.searchParams.get('iss')!=='https://internal.110-lab.cn')throw new Error('返回地址无效');location.replace(u.href);}else{const destination=service()?.url;if(!destination)throw new Error('入口不存在');location.assign(destination);}}catch(e){message(e.message);busy=false;paint();}}
async function initialize(){if(busy)return;busy=true;message('');paint();try{config=await request('config');if(!valid)throw new Error('连接链接已失效，请从应用重新发起');if(!service()||(isFlow&&!service().federated))throw new Error('应用尚未接入，请从应用重新发起');
    if(isFlow){const details=await request('validate',flow);$('scope-summary').textContent='将向'+details.name+'提供：'+details.scopes.map(s=>s.label).join('、')+'。';$('scope-summary').hidden=false;}
    flowValid=true;try{profile=await request('session');}catch(e){if(e.status!==401)throw e;profile=undefined;}
    ready=true;busy=false;if(embedded&&!profile)message('请先在工作台完成登录，再返回 Makit 继续。');if(!config.enabled)message('登录暂时不可用，请稍后重试');paint();
    if(profile&&config.enabled){const automatic=isFlow?(await request('continuation',flow)).automatic:params.has('service');if(automatic)await continueLogin();}
  }catch(e){message(e.message);ready=false;busy=false;paint();}}
$('continue').addEventListener('click',()=>void continueLogin());$('change').addEventListener('click',()=>void continueLogin(true));
if(embedded)window.addEventListener('message',event=>{if(event.source===window.parent&&event.data?.type==='110lab-workspace-activated')void initialize();});
void initialize();
