export function bindSuiteBrandFocus(identity){
 if(!identity)return;
 const link=identity.querySelector('[data-cobuild-brand]');
 identity.addEventListener('keydown',event=>{if(event.key==='Tab')identity.dataset.preserveAppFocus='true';},true);
 identity.addEventListener('pointerdown',()=>delete identity.dataset.preserveAppFocus,true);
 link?.addEventListener('pointermove',()=>delete identity.dataset.preserveAppFocus);
}
export function initSuiteBrand(){
// Kick suite branding belongs in the sidebar, beside its collapse control.
if (['/projects','/projects/','/projects/embedded'].includes(location.pathname)) {
 const row=document.querySelector('.cb-brand-row'),heading=document.getElementById('cb-page-title');
 if(heading?.querySelector('[data-cobuild-brand]'))heading.textContent='项目';
 if(row&&!row.querySelector('[data-suite-sidebar]')){
  const identity=document.createElement('span');identity.className='suite-identity';identity.dataset.suiteSidebar='true';
  identity.innerHTML='<span class="suite-slot"><a class="suite-link" href="https://cobuild.110-lab.cn/" aria-label="CoBuild 首页" data-cobuild-brand><span class="suite-initial" aria-hidden="true"></span><span class="suite-wordmark" aria-hidden="true"></span></a></span><span class="suite-divider" aria-hidden="true"></span><span class="suite-application"><a href="/projects" aria-label="Kick 项目首页"><img src="/assets/cobuild/kick.png" width="26" height="26" alt="" aria-hidden="true"><span>Kick</span></a></span>';
  const previous=row.querySelector('.brand');if(previous)previous.replaceWith(identity);else row.prepend(identity);
  const link=identity.querySelector('[data-cobuild-brand]');
  identity.addEventListener('keydown',e=>{if(e.key==='Tab')identity.dataset.preserveAppFocus='true'},true);
  identity.addEventListener('pointerdown',()=>delete identity.dataset.preserveAppFocus,true);
  link.addEventListener('pointermove',()=>delete identity.dataset.preserveAppFocus);
 }
}

}
