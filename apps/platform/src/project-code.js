// A small read-only source panel; it never renders provider HTML or requests external URLs.
const node=(tag,cls,value)=>{const n=document.createElement(tag);n.className=cls||'';if(value!==undefined)n.textContent=value;return n;};
const labels={idle:'按需读取 GitHub 公共仓库',loading:'正在读取代码状态…',disabled:'代码来源未启用',not_configured:'尚未关联代码仓库',unsupported:'暂不支持此仓库地址',unavailable:'代码来源暂时不可用',timeout:'代码来源读取超时',rate_limited:'GitHub 请求额度已用完，请稍后重试',busy:'读取繁忙，请稍后重试',restricted:'无法公开读取此仓库',not_found:'仓库不存在或未公开',repository_moved:'仓库地址已变化，请在管理中更新链接',repository_changed:'仓库身份已变化，请刷新后核对',project_changed:'项目已变化，请刷新项目',head_changed:'提交已更新，请刷新代码状态',partial:'仅取得部分检查，无法确认完整结果',invalid_request:'检查引用已失效，请刷新代码状态'};
const outcomes={none:'未发现检查',passed:'已读取的检查通过',failed:'存在失败检查',running:'检查进行中',other:'存在跳过、取消或未知结果',unknown:'检查结果未读全'};
const checks={passed:'通过',failed:'失败',running:'进行中',cancelled:'已取消',neutral:'中性',skipped:'已跳过',unknown:'未知'};
function external(parent,label,url){try{const u=new URL(url);if(u.origin!=='https://github.com'||u.username||u.password)return;}catch{return;}
  const a=node('a','ws-code-link',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);}
export function createProjectCodeView({api,current,onDenied}){
  let entry=null,epoch=0;
  const key=(p,subject)=>JSON.stringify([subject,p.id,p.revision,p.links?.repository]);
  const live=(p,k)=>{const context=current();return context?.project&&key(context.project,context.subject)===k;};
  function render(parent,p,{enabled,subject}){
    const k=key(p,subject);
    if(!entry||entry.key!==k)entry={key:k,data:{state:'idle'},details:new Map(),open:null,serial:0};
    const row=entry,focus=parent.contains(document.activeElement)?document.activeElement?.dataset.codeFocus:null;
    parent.replaceChildren(node('h4','','代码状态'));
    const state=!enabled?'disabled':!p.links?.repository?'not_configured':row.data.state;
    parent.setAttribute('aria-busy',String(state==='loading'));
    if(!enabled || !p.links?.repository){parent.append(node('p','',labels[state]));return;}
    const actions=node('div','ws-overview-actions');
    const reload=node('button','ws-btn ws-btn-ghost',row.data.state==='idle'?'加载代码状态':'刷新代码状态');reload.type='button';reload.dataset.codeFocus='reload';reload.setAttribute('aria-disabled',String(state==='loading'));
    reload.onclick=()=>{if(row.data.state!=='loading')void load();};actions.append(reload);external(actions,'打开仓库',p.links.repository);parent.append(actions);
    const paint=()=>{const container=document.getElementById('ws-overview-code');if(container&&entry===row&&live(p,k))render(container,p,{enabled,subject});};
    async function read(path,apply){const runEpoch=epoch,serial=row.serial;
      try{const result=await api(path);if(runEpoch!==epoch||entry!==row||row.serial!==serial)return;if(!live(p,k)){entry=null;return;}apply(result);}
      catch(e){if(runEpoch!==epoch||entry!==row||row.serial!==serial)return;if(!live(p,k)){entry=null;return;}if([401,403].includes(e.status)){reset();onDenied(e);return;}apply({state:'unavailable'});}
      if(entry===row&&!live(p,k))entry=null;
      paint();
    }
    async function load(){row.serial++;row.data={state:'loading'};row.open=null;row.details.clear();paint();
      await read('projects/'+p.id+'/overview/code',value=>{row.data=value;});}
    async function detail(pr){row.details.set(pr.number,{state:'loading'});paint();
      await read('projects/'+p.id+'/overview/code/pulls/'+pr.number+'/checks?'+new URLSearchParams({head:pr.headSha,repository:row.data.repository.repositoryId}),value=>row.details.set(pr.number,value));}
    if(state!=='ready'){
      const message=node('p','ws-code-status',labels[state]||labels.unavailable);message.setAttribute('role','status');parent.append(message);
      if(row.data.retryAfter)parent.append(node('p','ws-side-hint','请在 '+row.data.retryAfter+' 秒后重试'));
    }else{
      const when=new Date(row.data.fetchedAt).toLocaleString();
      parent.append(node('p','ws-side-hint','读取于 '+when+(row.data.cached?' · 缓存结果':'')));
      if(!row.data.pullRequests.length)parent.append(node('p','','尚无合并请求'));
      const list=node('ul','ws-code-list');
      for(const pr of row.data.pullRequests){
        const item=node('li','ws-code-item'),heading=node('div','ws-code-heading');
        external(heading,'#'+pr.number+' '+pr.title,pr.url);
        heading.append(node('span','ws-badge',({open:'打开',draft:'草稿',closed:'已关闭',merged:'已合并'})[pr.state]||'未知'));item.append(heading);
        item.append(node('p','ws-code-sha','提交 '+pr.headSha.slice(0,12)));
        const toggle=node('button','ws-btn ws-btn-ghost',row.open===pr.number?'收起检查':'查看检查');toggle.type='button';toggle.dataset.codeFocus='pull-'+pr.number;toggle.setAttribute('aria-expanded',String(row.open===pr.number));toggle.setAttribute('aria-controls','ws-code-checks-'+pr.number);
        toggle.onclick=()=>{row.open=row.open===pr.number?null:pr.number;if(row.open&&!row.details.has(pr.number))void detail(pr);else paint();};item.append(toggle);
        if(row.open===pr.number){
          const details=node('div','ws-code-checks');details.id='ws-code-checks-'+pr.number;
          const value=row.details.get(pr.number)||{state:'loading'};
          details.setAttribute('aria-busy',String(value.state==='loading'));
          const message=node('p','ws-code-status',value.state==='ready'?outcomes[value.outcome]||outcomes.unknown:labels[value.state]||labels.unavailable);message.setAttribute('role','status');details.append(message);
          if(value.headSha)details.append(node('p','ws-code-sha','结果对应 '+value.headSha.slice(0,12)));
          if(value.fetchedAt)details.append(node('p','ws-side-hint','读取于 '+new Date(value.fetchedAt).toLocaleString()+(value.cached?' · 缓存结果':'')));
          const items=node('ul','ws-code-check-list');
          for(const check of value.checks||[]){const li=node('li','');li.append(node('span','',check.name),node('span','',checks[check.state]||'未知'));items.append(li);}details.append(items);
          if(value.state!=='loading'){
            const again=node('button','ws-btn ws-btn-ghost','刷新检查');again.type='button';again.dataset.codeFocus='check-'+pr.number;again.onclick=()=>void detail(pr);details.append(again);
            if(value.url)external(details,'在 GitHub 查看检查',value.url);
          }
          item.append(details);
        }
        list.append(item);
      }
      parent.append(list);
      if(row.data.partial)parent.append(node('p','ws-side-hint','仅显示最近更新的 5 项'));
    }
    if(focus)Array.from(parent.querySelectorAll('[data-code-focus]')).find(n=>n.dataset.codeFocus===focus)?.focus({preventScroll:true});
  }
  function reset(){entry=null;epoch++;}
  return {render,reset};
}
