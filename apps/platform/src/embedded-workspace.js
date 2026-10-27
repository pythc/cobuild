import {handleResumeDownloadRequest} from './resume-download.js';
import {handleMailAttachmentDownloadRequest} from './mail-attachment-download.js';
import {validVersion} from './workbench-release.js';
// Only these owned applications can become embedded pages. Never accept a
// frame URL from tool results, query parameters, messages or local storage.
export const EMBEDDED_APPS = Object.freeze({
  monitoring:Object.freeze({title:'Pulse',url:'https://internal.110-lab.cn/monitoring',externalUrl:'https://internal.110-lab.cn/monitoring',nav:false}),
  honors:Object.freeze({title:'奖项荣誉',url:'https://internal.110-lab.cn/honors/embedded',externalUrl:'https://internal.110-lab.cn/honors',nav:false}),
  'recruitment-test':Object.freeze({title:'招新管理',url:'https://internal.110-lab.cn/recruitment/embedded',externalUrl:'https://internal.110-lab.cn/recruitment',nav:false}),
  projects:Object.freeze({title:'项目立项',url:'https://internal.110-lab.cn/projects/embedded',externalUrl:'https://internal.110-lab.cn/projects',nav:false}),
  organization: Object.freeze({title:'组织与权限',url:'https://internal.110-lab.cn/organization/embedded',externalUrl:'https://internal.110-lab.cn/organization',nav:false}),
  'public-mail': Object.freeze({title:'公共邮箱管理',url:'https://internal.110-lab.cn/mail/embedded',externalUrl:'https://internal.110-lab.cn/mail',nav:false}),
  assessment: Object.freeze({title: '考核系统', url: 'https://exam.110-lab.cn/api/auth/feishu/start?embedded=1', externalUrl:'https://exam.110-lab.cn/api/auth/feishu/start'}),
  requirements: Object.freeze({title: 'Makit', url: 'https://makit.110-lab.cn'}),
  'updates-admin': Object.freeze({
    title: '动态管理',
    url: 'https://internal.110-lab.cn/admin/embedded',
    externalUrl: 'https://internal.110-lab.cn/admin',
    nav: false
  })
});

// Nested application pages cannot open a Codex window themselves. Forward only
// these two exact destinations through the host bridge, never arbitrary links.
export async function handleMailExternalRequest(event,{frame,openExternal,callTool}) {
  if(event.origin!=='https://internal.110-lab.cn'||event.source!==frame?.contentWindow)return false;
  const m=event.data;
  if(m?.type==='110lab-mail-host-login'&&/^[\w-]{43}$/.test(m.state||'')&&typeof m.fresh==='boolean'&&(m.silent===undefined||typeof m.silent==='boolean')){
    let result,waitingForCallback=false;
    try{
      result=await callTool?.({name:'connect_110lab_mail',arguments:{state:m.state,fresh:m.fresh,...(m.silent?{silent:true}:{})}});
      const authorization=result?._meta?.mailAuthorization;
      if(authorization){
        waitingForCallback=true;
        if(m.silent)throw new Error('Interactive login required');
        const url=new URL(authorization.url);
        if(result.isError||authorization.state!==m.state||url.origin!=='https://internal.110-lab.cn'||url.pathname!=='/authorize'||url.username||url.password||url.hash||typeof openExternal!=='function')throw new Error('Invalid login bridge');
        const opened=await openExternal(url.href);if(opened?.isError)throw new Error('Not opened');
        frame.contentWindow.postMessage({type:'110lab-mail-host-opened',state:m.state},'https://internal.110-lab.cn');
        const deadline=Date.now()+270000;
        for(;;){
          result=await callTool({name:'complete_110lab_mail_login',arguments:{state:m.state}});
          if(!result?._meta?.mailAuthorizationPending)break;
          if(result._meta.mailAuthorizationPending.state!==m.state||Date.now()>=deadline)throw new Error('Login expired');
          await new Promise(resolve=>setTimeout(resolve,1500));
        }
      }
    }catch{if(waitingForCallback)try{await callTool({name:'complete_110lab_mail_login',arguments:{state:m.state,cancel:true}});}catch{}result=null;}
    const handoff=result?._meta?.mailHandoff;
    const valid=!result?.isError&&handoff?.state===m.state&&/^[\w-]{43}$/.test(handoff?.ticket||'');
    frame.contentWindow.postMessage({type:'110lab-mail-host-result',state:m.state,...(valid?{ticket:handoff.ticket}:{updateRequired:!!result?._meta?.['mcp/www_authenticate']})},'https://internal.110-lab.cn');
    return true;
  }
  if(typeof openExternal!=='function')return false;
  if(m?.type==='110lab-mail-open-login'&&/^[\w-]{43}$/.test(m.state||'')&&m.url==='https://internal.110-lab.cn/mail/auth/launch?state='+m.state){
    let opened=false;
    try{const result=await openExternal(m.url);opened=result?.isError!==true;}catch{}
    frame.contentWindow.postMessage({type:'110lab-mail-open-result',state:m.state,opened},'https://internal.110-lab.cn');
    return true;
  }
  if(m?.type==='110lab-mail-open-mailbox'&&m.url==='https://www.feishu.cn/mail'){
    let opened=false;
    try{const result=await openExternal(m.url);opened=result?.isError!==true;}catch{}
    frame.contentWindow.postMessage({type:'110lab-mail-mailbox-result',opened},'https://internal.110-lab.cn');
    return true;
  }
  return false;
}

export const DIRECT_APPS = new Set(['monitoring', 'knowledge', 'recruitment-test', 'public-mail']);

const WORKBENCH_PAGE=Object.freeze({title:'工作台',url:'https://internal.110-lab.cn/workbench/embedded'});

export async function handleWorkspaceRequest(event,{frame,openExternal,callTool,show}) {
  if(event.origin!=='https://internal.110-lab.cn'||event.source!==frame?.contentWindow)return false;
  const m=event.data;
  if(m?.type==='110lab-workspace-open-app'&&(m.id==='workbench'||Object.hasOwn(EMBEDDED_APPS,m.id))){
    if(DIRECT_APPS.has(m.id)){await openExternal?.(EMBEDDED_APPS[m.id].externalUrl || EMBEDDED_APPS[m.id].url);return true;}
    if(m.id==='workbench'&&['home','apps'].includes(m.view)){show('workbench',null,m.view);return true;}
    const projectId=m.id==='projects'&&typeof m.projectId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(m.projectId)?m.projectId:null;
    const honorId=m.id==='honors'&&typeof m.honorId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(m.honorId)?m.honorId:null;
    if(projectId||honorId)show(m.id,projectId||honorId);else show(m.id);return true;
  }
  if(m?.type==='110lab-workspace-open-link'&&typeof m.url==='string'&&m.url.length<=2000){
    try{const url=new URL(m.url);if(url.protocol==='https:'&&!url.username&&!url.password)await openExternal?.(url.href);}catch{}return true;
  }
  if(m?.type==='110lab-workspace-requirements'&&/^[a-f0-9-]{36}$/.test(m.requestId||'')){
    let result={state:'unavailable',items:[]};
    try{const r=await callTool?.({name:'get_my_110lab_requirement_todos',arguments:{}});if(!r?.isError&&r?._meta?.requirementTodos)result=r._meta.requirementTodos;}catch{}
    frame.contentWindow.postMessage({type:'110lab-workspace-requirements-result',requestId:m.requestId,result},'https://internal.110-lab.cn');return true;
  }
  return false;
}

export function initEmbeddedWorkspace() {
  const main = document.querySelector('main.shell');
  const footer = document.querySelector('.wb-footer');
  const brand = document.querySelector('.brand-product');
  if (!main) return null;
  document.body?.classList.add('is-mcp-workspace');
  const nav = document.createElement('nav');
  nav.className = 'workspace-nav';
  nav.setAttribute('aria-label', '工作区');
  const pages = new Map();
  const controls = new Map();
  let externalOpener=null;
  let installedPluginVersion=null;
  function sendReleaseContext(frame){frame?.contentWindow.postMessage({type:'110lab-workspace-release-context',installedPluginVersion},'https://internal.110-lab.cn');}
  let fileDownloader=null,downloadPending=false;
  let toolCaller=null,loginPending=false,resolveToolReady;
  const toolReady=new Promise(resolve=>{resolveToolReady=resolve;});
  const actions=document.createElement('div');
  actions.className='workspace-actions';actions.hidden=true;
  const external=document.createElement('a');external.target='_blank';external.rel='noopener noreferrer';external.textContent='独立打开';
  const retry=document.createElement('button');retry.type='button';retry.textContent='重新加载';
  let selectedWorkbenchView='home';
  let currentId='workbench',selectedProjectId=null,selectedHonorId=null,entryAttempt=0;
  const entryChecks=new Map();
  const entryStatus=document.createElement('p');entryStatus.className='workspace-entry-status';entryStatus.hidden=true;entryStatus.setAttribute('role','status');document.body.append(entryStatus);
  function checkEntry(id){return new Promise(resolve=>{const frame=pages.get('workbench')?.querySelector('iframe');if(!frame){resolve({allowed:false,error:'请先打开工作台'});return;}const requestId=crypto.randomUUID(),timer=setTimeout(()=>{entryChecks.delete(requestId);resolve({allowed:false,error:'应用权限核对超时 请重试'});},12000);entryChecks.set(requestId,{resolve,timer});frame.contentWindow.postMessage({type:'110lab-application-entry-check',requestId,id},'https://internal.110-lab.cn');});}
  external.addEventListener('click',async event=>{if(!externalOpener)return;event.preventDefault();try{await externalOpener(external.href);}catch{}});
  retry.addEventListener('click',()=>{const page=pages.get(currentId);if(page)page.querySelector('iframe').src='https://internal.110-lab.cn/apps/embedded/'+currentId;});
  const back=document.createElement('button');back.type='button';back.textContent='返回工作台';back.addEventListener('click',()=>show('workbench'));
  actions.append(back,external,retry);
  const outlet = document.createElement('div');
  outlet.className = 'workspace-outlet';
  outlet.hidden = true;
  main.after(outlet);
  document.querySelector('.masthead-inner')?.append(nav);
  document.body.append(actions);

  function createPage(id) {
    const app = id==='workbench'?WORKBENCH_PAGE:EMBEDDED_APPS[id];
    const page = document.createElement('section');
    page.className = 'embedded-page';
    page.tabIndex = -1;
    page.setAttribute('aria-label', app.title);
    const frame = document.createElement('iframe');
    frame.title = app.title;
    frame.referrerPolicy = 'no-referrer';
    frame.src = (id==='workbench'?app.url:'https://internal.110-lab.cn/apps/embedded/'+id)+(id==='honors'&&selectedHonorId?'?record='+encodeURIComponent(selectedHonorId):'');
    frame.addEventListener('load',()=>{if(['workbench','projects'].includes(id))sendReleaseContext(frame);if(id==='workbench')frame.contentWindow.postMessage({type:'110lab-workspace-view',view:selectedWorkbenchView},'https://internal.110-lab.cn');if(id==='projects'&&selectedProjectId)frame.contentWindow.postMessage({type:'110lab-workspace-select-project',projectId:selectedProjectId},'https://internal.110-lab.cn');});
    // Each app keeps its own login boundary. The parent never reads credentials,
    // session storage or page contents, and never executes business operations.
    page.append(frame);
    outlet.append(page);
    pages.set(id, page);
    return page;
  }

  async function show(id,projectId=null,view=null) {
    const attempt=++entryAttempt;if(id!=='workbench'){const result=await checkEntry(id);if(attempt!==entryAttempt)return;if(!result.allowed){entryStatus.textContent=result.error||'你暂时没有此应用的访问权限';entryStatus.hidden=false;return;}}entryStatus.hidden=true;
    if(id==='workbench'&&['home','apps'].includes(view))selectedWorkbenchView=view;
    if (id !== 'workbench' && !Object.hasOwn(EMBEDDED_APPS, id)) return;
    if(id==='projects'){selectedProjectId=projectId;if(pages.has(id)&&projectId)pages.get(id).querySelector('iframe').contentWindow.postMessage({type:'110lab-workspace-select-project',projectId},'https://internal.110-lab.cn');}
    if(id==='honors'){selectedHonorId=projectId;if(pages.has(id)&&projectId)pages.get(id).querySelector('iframe').contentWindow.postMessage({type:'110lab-workspace-select-honor',honorId:projectId},'https://internal.110-lab.cn');}
    const mounted=pages.has(id);
    if (!mounted) createPage(id);
    else if(['workbench','projects','recruitment-test','honors','updates-admin','requirements'].includes(id))pages.get(id).querySelector('iframe').contentWindow.postMessage({type:'110lab-workspace-activated'},'https://internal.110-lab.cn');
    if(id==='workbench'&&view)pages.get(id).querySelector('iframe').contentWindow.postMessage({type:'110lab-workspace-view',view:selectedWorkbenchView},'https://internal.110-lab.cn');
    currentId=id;document.body.dataset.currentApp=id;actions.hidden=['workbench','projects'].includes(id);
    if(id!=='workbench'){external.href='https://internal.110-lab.cn/apps/enter/'+id;external.setAttribute('aria-label','独立打开'+EMBEDDED_APPS[id].title);retry.hidden=id!=='requirements';}
    main.hidden = true;
    if (footer) footer.hidden = true;
    outlet.hidden = false;
    for (const [key, page] of pages) page.hidden = key !== id;
    for (const [key, control] of controls) {
      control.setAttribute('aria-current', key === id ? 'page' : 'false');
    }
    if (brand) brand.textContent = id === 'workbench' ? '工作台' : EMBEDDED_APPS[id].title;
    // Keep already opened frames mounted while switching so an in-progress
    // answer or requirement edit is not reset by navigation in the plugin.
  }

  const navApps = Object.entries(EMBEDDED_APPS).filter(([, app]) => app.nav !== false);
  for (const [id, title] of [['workbench', '工作台'], ...navApps.map(([id, app]) => [id, app.title])]) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = title;
    control.addEventListener('click', () => show(id));
    controls.set(id, control);
    nav.append(control);
  }
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const card = event.target instanceof Element ? event.target.closest('a[data-app-id]') : null;
    const id = card?.dataset.appId;
    if (!id || !Object.hasOwn(EMBEDDED_APPS, id) || DIRECT_APPS.has(id)) return;
    event.preventDefault();
    show(id);
    (controls.get(id) || pages.get(id))?.focus();
  }, {capture: true});
  show('workbench');
  window.addEventListener('message',async event=>{
    if(event.origin==='https://internal.110-lab.cn'&&event.source===pages.get('workbench')?.querySelector('iframe')?.contentWindow&&event.data?.type==='110lab-application-entry-result'){const pending=entryChecks.get(event.data.requestId);if(pending){entryChecks.delete(event.data.requestId);clearTimeout(pending.timer);pending.resolve({allowed:event.data.allowed===true,error:typeof event.data.error==='string'?event.data.error.slice(0,160):''});}return;}
    const page=pages.get(currentId);
    if(!page||page.hidden||!['organization','public-mail','workbench','projects','recruitment-test','honors','updates-admin','assessment','requirements'].includes(currentId))return;
    const frame=page.querySelector('iframe');
    if(event.origin!=='https://internal.110-lab.cn'||event.source!==frame.contentWindow)return;
    if(currentId==='requirements'){if(event.data?.type==='110lab-workspace-open-app'&&event.data.id==='workbench')await show('workbench');return;}
    if(currentId==='recruitment-test'&&['110lab-resume-download','110lab-mail-attachment-download'].includes(event.data?.type)){
      if(downloadPending){frame.contentWindow.postMessage({type:event.data.type+'-result',requestId:event.data.requestId,status:'busy'},event.origin);return;}
      downloadPending=true;
      try{await (event.data.type==='110lab-resume-download'?handleResumeDownloadRequest:handleMailAttachmentDownloadRequest)(event,{frame,downloadFile:fileDownloader});}finally{downloadPending=false;}
      return;
    }
    if(['organization','workbench','projects','recruitment-test','honors'].includes(currentId)&&await handleWorkspaceRequest(event,{frame,openExternal:externalOpener,callTool:toolCaller,show}))return;
    if(event.data?.type==='110lab-mail-host-login'){
      if(loginPending)return;loginPending=true;
      try{if(!toolCaller)await Promise.race([toolReady,new Promise(resolve=>setTimeout(resolve,15000))]);await handleMailExternalRequest(event,{frame:page.querySelector('iframe'),openExternal:externalOpener,callTool:toolCaller});}finally{loginPending=false;}
    }else await handleMailExternalRequest(event,{frame:page.querySelector('iframe'),openExternal:externalOpener,callTool:toolCaller});
  });
  return {show,setReleaseContext({installedPluginVersion:version}={}){installedPluginVersion=validVersion(version)?version:null;for(const id of ['workbench','projects'])sendReleaseContext(pages.get(id)?.querySelector('iframe'));},setExternalOpener(opener){externalOpener=opener;},setFileDownloader(downloader){fileDownloader=downloader;},setToolCaller(caller){toolCaller=caller;resolveToolReady();pages.get('workbench')?.querySelector('iframe').contentWindow.postMessage({type:'110lab-workspace-ready'},'https://internal.110-lab.cn');}};
}
