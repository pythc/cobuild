// This editor only runs on the owned organization page; business roles stay in
// their existing store. Labels and profiles are text nodes, never HTML.
if(['/organization','/organization/','/organization/embedded'].includes(location.pathname)){
  const $=id=>document.getElementById(id),embedded=location.pathname.endsWith('/embedded'),prefix='/api/organization/'+(embedded?'embedded/':'')+'app-access';
  let identity=null,data=null,generation=0,serial=0,busy=false,drafts=new Map();
  const title={inherit:'沿用现有权限',everyone:'全体飞书成员',restricted:'指定成员或部门'};
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const status=text=>{$('access-status').textContent=text;};
  const selected=()=>data?.apps.find(a=>a.id===$('access-app').value);
  const draft=()=>{const app=selected();if(!app)return null;if(!drafts.has(app.id))drafts.set(app.id,structuredClone(app.policy));return drafts.get(app.id);};
  async function request(id,body){const r=await fetch(prefix+(id?'/'+encodeURIComponent(id):''),{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),headers:body?{'Content-Type':'application/json','X-CSRF-Token':identity?.csrf||''}:{},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok){const error=new Error(value.error||'权限暂时无法读取');error.code=value.code;throw error;}return value;}
  function renderOptions(target,rows,values,key,query){
    const q=query.trim().toLowerCase(),items=rows.filter(r=>(r.name+' '+(r.email||'')+' '+(r.path||'')).toLowerCase().includes(q)),known=new Set(rows.map(r=>r[key]));
    for(const id of values)if(!known.has(id)&&(!q||id.toLowerCase().includes(q)))items.push({[key]:id,name:'已离开或移除 · '+id});
    $(target).replaceChildren(...items.map(row=>{const label=node('label'),input=node('input'),copy=node('span'),name=node('strong',row.path||row.name);input.type='checkbox';input.value=row[key];input.checked=values.includes(row[key]);input.disabled=busy||!data.directoryAvailable;copy.append(name);if(row.email)copy.append(node('small',row.email));label.append(input,copy);input.onchange=()=>{const d=draft(),field=key==='subject'?'subjects':'departmentIds';d[field]=input.checked?[...new Set([...d[field],row[key]])]:d[field].filter(v=>v!==row[key]);renderState();};return label;}));
    if(!items.length)$(target).append(node('p',q?'没有匹配项':'暂无可选择的成员'));
  }
  function renderState(){
    const d=draft();if(!d)return;const restricted=d.mode==='restricted';$('access-targets').hidden=!restricted;
    document.querySelectorAll('input[name="access-mode"]').forEach(r=>{r.checked=r.value===d.mode;r.disabled=busy||(!data.directoryAvailable&&r.value!=='inherit');});
    $('access-summary').textContent=restricted?'已选择 '+d.subjects.length+' 位个人和 '+d.departmentIds.length+' 个部门'+(!d.subjects.length&&!d.departmentIds.length?' 仅超级管理员可进入':''):d.mode==='everyone'?'自动包含当前可用的飞书成员 新成员加入后自动生效':'保持该应用当前的账号与权限规则';
    document.querySelectorAll('#access-members input,#access-departments input').forEach(c=>c.disabled=busy||!data.directoryAvailable);$('access-reset').disabled=busy;
    $('access-save').disabled=busy||(!data.directoryAvailable&&d.mode!=='inherit');$('access-app').disabled=busy;$('access-sync').disabled=busy;$('access-reload').disabled=busy;
  }
  function render(){
    if(!data)return;const d=draft();if(!d)return;const app=selected();$('access-boundary').textContent=['grading-public','grading-internal','lab-home'].includes(app.id)?'仅限制实验室成员从工作台进入 对外服务与独立账号保持不变':['knowledge','requirements','assessment'].includes(app.id)?'控制工作台及统一认证入口 应用内原有业务权限继续生效':'页面与业务接口同时校验应用权限';
    renderOptions('access-members',data.directory.members,d.subjects,'subject',$('access-member-search').value);
    renderOptions('access-departments',data.directory.departments,d.departmentIds,'id',$('access-department-search').value);
    $('access-sync-time').textContent=data.directory.syncedAt?'最近同步 '+new Date(data.directory.syncedAt).toLocaleString('zh-CN')+' · 自动同步约 1 分钟':'尚未完成同步';renderState();
    const names=new Map(data.apps.map(a=>[a.id,a.title]));$('access-history').replaceChildren(...data.audit.map(e=>{const li=node('li'),actor=data.directory.members.find(m=>m.subject===e.actor);li.append(node('p',(names.get(e.appId)||e.appId)+' · '+title[e.policy.mode]),node('small',new Date(e.at).toLocaleString('zh-CN')+' · '+(actor?.name||e.actor)+' · v'+e.revision));return li;}));
  }
  async function load(){if(!identity||identity.role!=='super_admin'||busy)return;const epoch=generation,read=++serial;status('正在读取应用权限');try{const value=await request();if(epoch!==generation||read!==serial)return;const previous=$('access-app').value;data=value;$('access-app').replaceChildren(...data.apps.map(a=>{const o=node('option',a.title);o.value=a.id;return o;}));if(data.apps.some(a=>a.id===previous))$('access-app').value=previous;status(data.directoryAvailable?'':'飞书通讯录暂时无法同步 可查看或恢复现有权限');render();}catch(e){if(epoch===generation&&read===serial)status(e.name==='TimeoutError'?'读取超时，请重试':e.message);}}
  document.addEventListener('110lab:organization-identity',event=>{const next=event.detail,changed=identity?.subject!==next?.subject||identity?.role!==next?.role;identity=next;if(!changed)return;generation++;serial++;busy=false;data=null;drafts.clear();$('access-reauth').hidden=true;$('access-app').replaceChildren();$('access-members').replaceChildren();$('access-departments').replaceChildren();$('access-history').replaceChildren();$('access-save').disabled=true;status('');if(next?.role==='super_admin')void load();});
  document.querySelector('[data-tab="access"]').addEventListener('click',()=>{if(!data)void load();});
  $('access-app').onchange=()=>{status('');$('access-member-search').value='';$('access-department-search').value='';render();};
  for(const id of ['access-member-search','access-department-search'])$(id).oninput=render;
  document.querySelectorAll('input[name="access-mode"]').forEach(r=>r.onchange=()=>{const d=draft();if(d){d.mode=r.value;renderState();}});
  $('access-reauth').onclick=()=>document.getElementById('reauth').click();
  $('access-reload').onclick=()=>{drafts.clear();void load();};
  $('access-reset').onclick=()=>{const app=selected();if(app){drafts.delete(app.id);render();status('已恢复为当前已保存的权限');}};
  $('access-sync').onclick=async()=>{if(busy)return;const epoch=generation;busy=true;renderState();status('正在同步飞书通讯录');try{const r=await fetch(prefix+'/directory',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':identity?.csrf||''},body:'{}',signal:AbortSignal.timeout(15000)});const value=await r.json();if(!r.ok)throw new Error(value.error||'同步失败');if(epoch!==generation)return;data.directory=value.directory;data.directoryAvailable=value.directoryAvailable;status(value.directoryAvailable?'同步完成':'飞书同步暂时不可用');}catch(e){if(epoch===generation)status(e.message);}finally{if(epoch===generation){busy=false;render();}}};
  $('access-form').onsubmit=async event=>{event.preventDefault();const d=draft(),app=selected();if(!d||!app||busy)return;const epoch=generation,id=app.id,body={revision:d.revision,policy:{mode:d.mode,subjects:d.mode==='restricted'?d.subjects:[],departmentIds:d.mode==='restricted'?d.departmentIds:[]}};busy=true;renderState();status('正在保存');try{const value=await request(id,body);if(epoch!==generation)return;app.policy=value;data.audit.unshift({appId:id,revision:value.revision,at:value.updatedAt,actor:identity.subject,policy:value});data.audit=data.audit.slice(0,100);drafts.delete(id);$('access-reauth').hidden=true;status('权限已保存');}catch(e){if(epoch===generation){$('access-reauth').hidden=e.code!=='REAUTH_REQUIRED';status(e.name==='TimeoutError'?'保存结果暂未确认 请重新读取后核对':e.message);}}finally{if(epoch===generation){busy=false;render();}}};
}
