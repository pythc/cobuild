import {createContentMotion} from './cobuild-motion/content-motion.mjs';
const viewMotion=createContentMotion();
window.addEventListener('pagehide',()=>viewMotion.cancel());
import {EMBEDDED_APPS,DIRECT_APPS} from './embedded-workspace.js';
import {applyAppBranding} from './app-branding.js';
import {APP_GROUPS, appGroup, appIcon, matchesApp, safeAppUrl} from './workbench-catalog.js';
import {createFavoritesClient} from './workbench-favorites.js';
import {createReleaseMonitor,validVersion,WORKBENCH_VERSION,WORKBENCH_BUILD} from './workbench-release.js';
const $ = id => document.getElementById(id);
const runtime = {opener:null, apps:[], listening:false, releaseMonitor:null, installedPluginVersion:null, attempt:0, messageTimer:0, profile:null, view:'home', category:'all', favorites:null, favoriteFocus:null, assetBase:'',access:null,accessRead:0};
const projectPage = ['/projects','/projects/','/projects/embedded'].includes(location.pathname);
const embedded = ['/workbench/embedded','/projects/embedded'].includes(location.pathname);
function node(tag, cls, text) { const value=document.createElement(tag);if(cls)value.className=cls;if(text!==undefined)value.textContent=text;return value; }
function assetUrl(src){return runtime.assetBase+src+(WORKBENCH_BUILD?'?v='+WORKBENCH_BUILD:'');}
function icon(src, cls='') { const value=node('img',cls);value.src=assetUrl(src);value.alt='';return value; }
function appLink(app, cls) {
  const href=safeAppUrl(app.url), link=node(href?'a':'div',cls);
  link.dataset.appId=app.id;
  if(href){link.href=runtime.assetBase?href:'/apps/enter/'+app.id+(embedded?'?embedded=1':'');link.target='_blank';link.rel='noopener noreferrer';}
  const access=runtime.access?.[app.id];if(!runtime.assetBase&&access?.allowed!==true){link.removeAttribute('href');link.setAttribute('aria-disabled','true');link.title=access?.reason||'正在核对应用权限';}
  return link;
}
async function loadApplicationAccess(){
  if(runtime.assetBase)return;
  const read=++runtime.accessRead;try{
    const response=await fetch('/api/application-access/'+(embedded?'embedded/':'')+'entries',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)}),value=await response.json();if(!response.ok||!value?.apps)throw new Error();
    if(read!==runtime.accessRead)return;
    if(runtime.profile&&value.subject!==runtime.profile.subject)throw new Error();
    const states={};for(const app of runtime.apps){const row=value.apps[app.id];if(typeof row?.allowed!=='boolean')throw new Error();states[app.id]={allowed:row.allowed,reason:typeof row.reason==='string'?row.reason:'',status:row.status};}runtime.access=states;
  }catch{if(read!==runtime.accessRead)return;runtime.access=Object.fromEntries(runtime.apps.map(app=>[app.id,{allowed:false,reason:'暂时无法核对应用权限，请刷新后重试',status:503}]));}
  renderFavorites();document.dispatchEvent(new CustomEvent('110lab:application-access',{detail:runtime.access}));
}
function appImage(app) { const url=appIcon(app);return icon(url,'cb-app-icon'+(url.includes('/icons/')?' is-standard':'')); }
function message(text) {
  const value=$('link-message');if(!value)return;
  clearTimeout(runtime.messageTimer);value.textContent=text;value.hidden=false;
  runtime.messageTimer=setTimeout(()=>{value.hidden=true;value.textContent='';},5000);
}
function favoriteState(){return runtime.favorites?.snapshot() || {favoriteAppIds:[],ready:false,pending:false};}
function renderQuick() {
  const list=$('cb-quick-list');if(!list)return;
  const selected=[...favoriteState().favoriteAppIds,'projects','requirements','knowledge','public-mail'];
  const apps=[...new Set(selected)].map(id=>runtime.apps.find(a=>a.id===id)).filter(Boolean).slice(0,4);
  list.replaceChildren(...apps.map(app=>{const item=node('li'),link=appLink(app,'cb-quick-link'),copy=node('span','cb-quick-copy');copy.append(node('strong','',app.title),node('small','',app.originalTitle===app.title?app.edition:app.originalTitle));link.append(appImage(app),copy);item.append(link);return item;}));
}
function renderFavorites() {
  const state=favoriteState(),list=$('cb-favorites-list'),empty=$('cb-favorites-empty'),status=$('cb-favorites-status');
  if(list)list.replaceChildren(...state.favoriteAppIds.map(id=>runtime.apps.find(a=>a.id===id)).filter(Boolean).map(app=>{const item=node('li'),link=appLink(app,'cb-nav-link');link.title=app.title+(app.originalTitle!==app.title?' · '+app.originalTitle:'');link.setAttribute('aria-label',link.title);link.append(icon(appIcon(app)),node('span','',app.title));item.append(link);return item;}));
  if(empty){empty.hidden=state.favoriteAppIds.length>0||!!state.error;empty.textContent=!runtime.profile?'登录后收藏常用应用':state.pending&&!state.ready?'正在加载收藏…':'在应用页收藏常用应用';}
  if(status){status.textContent=state.error;status.hidden=!state.error;}
  const retry=$('cb-favorites-retry');if(retry){retry.hidden=!state.error;retry.disabled=state.pending;}
  renderQuick(); renderApps();
}
function renderApps() {
  const grid=$('app-grid');if(!grid)return;
  const query=$('app-search')?.value||'',state=favoriteState();
  const shown=runtime.apps.filter(app=>(runtime.category==='all'||appGroup(app)===runtime.category)&&matchesApp(app,query));
  const items=[];
  for(const [category,label] of Object.entries(APP_GROUPS)) {
    const apps=shown.filter(app=>appGroup(app)===category);if(!apps.length)continue;
    const group=node('li','cb-app-group',label);items.push(group);
    for(const app of apps){
      const item=node('li','cb-app-item'),link=appLink(app,'app-card'),copy=node('div','cb-app-copy'),title=node('h3','',app.title);
      if(app.originalTitle&&app.originalTitle!==app.title)title.append(node('small','',app.originalTitle));
      if(app.status==='intranet')title.append(node('span','cb-app-badge','内网'));
      if(!runtime.assetBase&&runtime.access?.[app.id]?.allowed===false)title.append(node('span','cb-app-badge',runtime.access[app.id].status===401?'需登录':runtime.access[app.id].status===503?'暂不可用':'无访问权限'));
      if(app.status==='disabled')title.append(node('span','cb-app-badge','尚未启用'));
      copy.append(title,node('p','',app.description));link.append(appImage(app),copy,icon('/assets/icons/arrow-up-right.svg','cb-app-arrow'));
      const selected=state.favoriteAppIds.includes(app.id),star=node('button','cb-favorite-button');star.type='button';star.dataset.favoriteAppId=app.id;star.setAttribute('aria-pressed',String(selected));star.setAttribute('aria-label',(selected?'取消收藏 ':'收藏 ')+app.title);star.title=!runtime.profile?'登录后可收藏':selected?'取消收藏':'收藏';star.disabled=!runtime.profile||!state.ready||state.pending;
      star.append(icon('/assets/icons/'+(selected?'star-filled':'star')+'.svg'));
      star.onclick=()=>{runtime.favoriteFocus=app.id;void runtime.favorites.setFavorite(app.id,!selected);};item.append(link,star);items.push(item);
    }
  }
  const focused=document.activeElement?.dataset?.favoriteAppId;
  grid.replaceChildren(...items);
  if(!state.pending&&(focused||runtime.favoriteFocus)){if(document.activeElement===document.body||focused)grid.querySelector('[data-favorite-app-id="'+(focused||runtime.favoriteFocus)+'"]')?.focus();runtime.favoriteFocus=null;}
  grid.hidden=shown.length===0;
  if($('app-empty'))$('app-empty').hidden=shown.length>0;
  if($('app-count'))$('app-count').textContent=(query.trim()?'找到 '+shown.length+' 个应用':shown.length+' 个应用');
  if($('app-search-clear'))$('app-search-clear').hidden=!query;
  document.querySelectorAll('[data-app-category]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.appCategory===runtime.category)));
}
function setView(view,{navigate=false}={}) {
  const previous=runtime.view;
  if(projectPage)return;
  runtime.view=view==='apps'?'apps':'home';document.body.classList.toggle('is-apps-view',runtime.view==='apps');
  $('apps').hidden=runtime.view!=='apps';
  if(previous!==runtime.view)viewMotion.enter(document.querySelector('.cb-main'),runtime.view);
  $('cb-page-title').textContent=runtime.view==='apps'?'应用':'工作台';document.title=(runtime.view==='apps'?'应用':'工作台')+' · CoBuild';
  $('cb-nav-home').setAttribute('aria-current',runtime.view==='home'?'page':'false');$('cb-nav-apps').setAttribute('aria-current',runtime.view==='apps'?'page':'false');
  if(navigate)history.pushState(null,'',runtime.view==='apps'?'#apps':location.pathname);
}
function setCollapsed(value) {
  document.body.classList.toggle('is-sidebar-collapsed',value);
  const button=$('cb-collapse');button.setAttribute('aria-expanded',String(!value));button.setAttribute('aria-label',value?'展开侧栏':'收起侧栏');button.querySelector('img').src=assetUrl('/assets/icons/layout-sidebar-left-'+(value?'expand':'collapse')+'.svg');
}
function restoreCollapse() {try{setCollapsed(localStorage.getItem('cobuild-sidebar:'+(runtime.profile?.subject||'anonymous'))==='collapsed');}catch{setCollapsed(false);} }
function identityChanged(profile) {
  const changed=(runtime.profile?.subject||null)!==(profile?.subject||null)||(runtime.profile?.csrf||'')!==(profile?.csrf||'')||runtime.profile?.role!==profile?.role;
  runtime.profile=profile?.subject?profile:null;
  $('cb-user-name').textContent=runtime.profile?.name||runtime.profile?.email||'未登录';$('cb-avatar').textContent=(runtime.profile?.name||'C').slice(0,1);$('cb-user-menu').querySelector('summary').setAttribute('aria-label',runtime.profile?.name||runtime.profile?.email||'账户菜单');if(changed)$('cb-user-menu').open=false;
  if(changed){restoreCollapse();if(!runtime.assetBase){runtime.access=Object.fromEntries(runtime.apps.map(a=>[a.id,{allowed:false,reason:'正在核对应用权限'}]));document.dispatchEvent(new CustomEvent('110lab:application-access',{detail:runtime.access}));void loadApplicationAccess();}}void runtime.favorites.setIdentity(runtime.profile);renderFavorites();
}
function renderUpdate({notice}) {
  $('cb-update-notice').hidden=!notice;
  $('cb-update-message').textContent=!notice?'':notice.plugin&&notice.web?'工作台已更新，插件 v'+notice.plugin.version+' 可更新':notice.plugin?'插件 v'+notice.plugin.version+' 可更新':'工作台已更新';
  $('cb-update-refresh').hidden=!notice?.web;
  $('plugin-update-install').hidden=!notice?.plugin;
}
function bindChrome() {
  if(runtime.listening)return;runtime.listening=true;
  const menu=$('cb-user-actions');for(const id of ['ws-role-chip','ws-admin-settings','ws-logout'])if($(id))menu.append($(id));
  document.addEventListener('110lab:identity',event=>identityChanged(event.detail));
  document.addEventListener('click',async event=>{
    if(runtime.assetBase||!embedded||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const target=event.target instanceof Element?event.target:null,link=target?.closest('a[data-app-id],#cb-nav-projects');if(!link)return;
    const id=link.id==='cb-nav-projects'?'projects':link.dataset.appId;if(!runtime.apps.some(a=>a.id===id))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(runtime.access?.[id]?.allowed!==true){message(runtime.access?.[id]?.reason||'正在核对应用权限');return;}
    try{const response=await fetch('/api/application-access/embedded/entry/'+id,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)}),value=await response.json();if(!response.ok)throw new Error(value.error||'当前无法进入应用');
      if(Object.hasOwn(EMBEDDED_APPS,id)&&!DIRECT_APPS.has(id))window.parent.postMessage({type:'110lab-workspace-open-app',id},'*');
      else if(runtime.opener)await runtime.opener(value.url);else throw new Error('请重新打开工作台后重试');
    }catch(e){message(e.name==='TimeoutError'?'应用权限核对超时，请重试':e.message);void loadApplicationAccess();}
  },{capture:true});
  document.addEventListener('click',event=>{
    const target=event.target instanceof Element?event.target:null,view=target?.closest('[data-cb-view]');
    if(view&&!projectPage&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();setView(view.dataset.cbView,{navigate:true});}
    if(target&&!target.closest('#cb-user-menu'))$('cb-user-menu').open=false;
    const link=target?.closest('a[target="_blank"]'),exact=link?.getAttribute('href');
    if(!event.defaultPrevented&&link&&runtime.opener&&exact&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();const attempt=++runtime.attempt;Promise.resolve().then(()=>runtime.opener(exact)).catch(()=>{if(attempt===runtime.attempt)message('暂时无法打开链接，请重试');});}
  });
  $('cb-collapse').onclick=()=>{const value=!document.body.classList.contains('is-sidebar-collapsed');setCollapsed(value);try{localStorage.setItem('cobuild-sidebar:'+(runtime.profile?.subject||'anonymous'),value?'collapsed':'expanded');}catch{}};
  window.addEventListener('message',event=>{
    if(!embedded||event.source!==window.parent)return;
    if(event.data?.type==='110lab-application-entry-check'&&/^[a-f0-9-]{36}$/.test(event.data.requestId||'')&&runtime.apps.some(a=>a.id===event.data.id)){const {requestId,id}=event.data;void(async()=>{let allowed=false,error='应用权限暂时无法核对';try{const response=await fetch('/api/application-access/embedded/entry/'+id,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)}),value=await response.json();allowed=response.ok&&value.allowed===true;error=allowed?'':value.error||error;}catch{}window.parent.postMessage({type:'110lab-application-entry-result',requestId,allowed,error},'*');})();return;}
    if(event.data?.type==='110lab-workspace-view'&&['home','apps'].includes(event.data.view))setView(event.data.view,{navigate:true});
    if(event.data?.type==='110lab-workspace-release-context'){
      runtime.installedPluginVersion=validVersion(event.data.installedPluginVersion)?event.data.installedPluginVersion:null;
      runtime.releaseMonitor?.setInstalledVersion(runtime.installedPluginVersion);
    }
    if(event.data?.type==='110lab-workspace-activated')void runtime.releaseMonitor?.check();
  });
  window.addEventListener('popstate',()=>setView(location.hash==='#apps'?'apps':'home'));
  setInterval(()=>{if(!document.hidden&&!runtime.assetBase)void loadApplicationAccess();},60000);
  window.addEventListener('focus',()=>{if(!runtime.assetBase)void loadApplicationAccess();if(runtime.profile)void runtime.favorites.refresh();void runtime.releaseMonitor?.check();});
  window.addEventListener('online',()=>void runtime.releaseMonitor?.check());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void runtime.releaseMonitor?.check();});
  window.addEventListener('pagehide',()=>runtime.releaseMonitor?.stop());
  window.addEventListener('pageshow',()=>void runtime.releaseMonitor?.start());
  $('app-search-form').onsubmit=event=>event.preventDefault();
  $('app-search').oninput=()=>{if(runtime.view!=='apps')setView('apps',{navigate:true});renderApps();};
  $('app-search').onkeydown=event=>{if(event.key==='Escape'){$('app-search').value='';renderApps();}};
  $('app-search-clear').onclick=()=>{$('app-search').value='';renderApps();$('app-search').focus();};
  document.querySelectorAll('[data-app-category]').forEach(button=>button.onclick=()=>{runtime.category=button.dataset.appCategory;renderApps();});
  $('cb-favorites-retry').onclick=()=>void runtime.favorites.refresh();
  $('cb-update-refresh').onclick=()=>location.reload();
  $('cb-update-dismiss').onclick=()=>runtime.releaseMonitor?.dismiss();
}
export function initWorkbench(config, options={}) {
  runtime.assetBase=options.assetBase==='https://internal.110-lab.cn'?options.assetBase:'';
  runtime.apps=applyAppBranding(Array.isArray(config?.apps)?config.apps:[]);
  runtime.favorites=createFavoritesClient({
    request:async(method,data,actor)=>{
      const response=await fetch('/api/workspace/'+(embedded?'embedded/':'')+'preferences',{method,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000),headers:method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':actor?.csrf||''}:{},...(data?{body:JSON.stringify(data)}:{})});
      const value=await response.json();if(!response.ok){const error=new Error(value.error||'收藏暂时不可用');error.status=response.status;throw error;}return value;
    },onChange:renderFavorites,onUnauthorized:()=>document.dispatchEvent(new CustomEvent('110lab:session-expired'))
  });
  bindChrome();restoreCollapse();
  if(globalThis.__COBUILD__&&!globalThis.__COBUILD__.modules.includes('kick'))$('cb-nav-projects').hidden=true;
  if(projectPage){document.body.classList.add('is-project-page');$('cb-page-title').textContent='项目';document.title='Kick 项目 · CoBuild';$('cb-nav-projects').setAttribute('aria-current','page');$('apps').hidden=true;}
  else setView(location.hash==='#apps'?'apps':'home');
  renderFavorites();
  return {
    loadApplicationAccess,applicationAccess:()=>runtime.access,
    refreshApps(apps){runtime.apps=applyAppBranding(apps);renderFavorites();},
    setReleaseChecker(checkRelease){
      runtime.releaseMonitor?.stop();
      let storage=null;try{storage=window.localStorage;}catch{}
      runtime.releaseMonitor=createReleaseMonitor({checkRelease,current:{version:WORKBENCH_VERSION,build:WORKBENCH_BUILD},installedVersion:runtime.installedPluginVersion,storage,isVisible:()=>!document.hidden,onChange:renderUpdate});
      void runtime.releaseMonitor.start();
    },
    setExternalOpener(fn){runtime.opener=typeof fn==='function'?fn:null;}
  };
}
