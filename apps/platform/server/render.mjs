export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
import {applyAppBranding} from '../src/app-branding.js';
import {appIcon, safeAppUrl} from '../src/workbench-catalog.js';
export function renderWorkbench(template,config){
  const cards=applyAppBranding(config.apps).map(app=>{
    const href=safeAppUrl(app.url), title=escapeHTML(app.title);
    const old=app.originalTitle!==app.title?'<small>'+escapeHTML(app.originalTitle)+'</small>':'';
    const badge=app.status==='intranet'?'<span class="cb-app-badge">内网</span>':'';
    return `<li class="cb-app-item"><${href?'a':'div'} class="app-card" data-app-id="${escapeHTML(app.id)}" ${href?`href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer"`:''}><img class="cb-app-icon" src="${escapeHTML(appIcon(app))}" alt=""><div class="cb-app-copy"><h3>${title}${old}${badge}</h3><p>${escapeHTML(app.description)}</p></div></${href?'a':'div'}></li>`;
  }).join('');
  return template.replace(/(<ul\b[^>]*\bid="app-grid"[^>]*>)[\s\S]*?<\/ul>/,(_,open)=>open+cards+'</ul>');
}
