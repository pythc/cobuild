import { randomBytes } from "node:crypto";
export function suiteOrganizationPage(config, actor) {
  const nonce = randomBytes(24).toString("base64"),
    escape = (s) =>
      String(s).replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
  const owner = actor.role === "super_admin";
  return {
    csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'`,
    html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>组织与权限 · CoBuild</title><style nonce="${nonce}">
  *{box-sizing:border-box}body{margin:0;background:#f6f8fc;color:#202532;font:15px system-ui,sans-serif}header{display:flex;gap:28px;align-items:center;padding:22px 32px;background:white;border-bottom:1px solid #e3e8f1}a{color:#334bd8;text-decoration:none}main{max-width:1100px;margin:36px auto;padding:0 24px}h1{font-size:28px}section{background:white;border:1px solid #e3e8f1;border-radius:16px;padding:24px;margin:20px 0}p{color:#647087;line-height:1.7}input,select,button{font:inherit;border:1px solid #d9dfec;border-radius:8px;padding:10px;background:white}button{cursor:pointer;color:#334bd8}form{display:flex;gap:10px;flex-wrap:wrap}input{min-width:240px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:15px 8px;border-bottom:1px solid #e9edf4}td:last-child{display:flex;gap:8px}#message{white-space:pre-wrap;overflow-wrap:anywhere;color:#3147aa}#error{color:#bc2647}small{color:#647087}@media(max-width:640px){section{padding:16px}table{font-size:13px}td,th{padding:10px 4px}td:last-child{flex-wrap:wrap}}</style>
  <header><a href="/workbench"><b>CoBuild</b> / ${escape(config.organization.name)}</a><span>组织与权限</span><a href="/account">账号安全与所有权</a><a href="/workbench">返回工作台</a></header><main><h1>组织与权限</h1><p>使用统一账号管理团队成员。应用能否进入与应用内的业务角色分别控制，组织管理员不会自动获得其他应用的管理员角色。</p><p id="error" role="alert"></p><section><h2>邀请成员</h2><form id="invite"><input type="email" name="email" aria-label="邮箱" placeholder="成员邮箱" required><select name="role" aria-label="组织角色"><option value="member">成员</option>${owner ? '<option value="admin">组织管理员</option>' : ""}</select><button>生成邀请链接</button></form><p>链接七天内有效，仅能使用一次；请自行交给受邀成员。本地验证不会发送邮件。</p><p id="message" role="status"></p></section><section><h2>成员</h2><small>仅组织所有者可调整管理员或停用账号。停用或退出后，已建立的统一应用会话随即失效。</small><div style="overflow:auto"><table><thead><tr><th>姓名</th><th>邮箱</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody id="members"></tbody></table></div></section><section><h2>应用模块</h2><p>${escape(config.modules.join(" · "))}</p><p>当前模块由套件配置文件管理，修改后需重启本地套件。本轮不提供在线修改部署配置。</p></section></main><script nonce="${nonce}">
  const csrf=${JSON.stringify(actor.csrf)},owner=${owner};
  const error=document.querySelector('#error');
  async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error||'操作失败');return v;}
  function cell(row,value){const td=document.createElement('td');td.textContent=value;row.append(td);return td;}
  async function load(){const data=await api('/api/organization/users');document.querySelector('#members').replaceChildren();for(const u of data.users){const row=document.createElement('tr');cell(row,u.name);cell(row,u.email);cell(row,{super_admin:'组织所有者',admin:'组织管理员',member:'成员'}[u.role]);cell(row,u.active?'启用':'停用');const ops=cell(row,'');if(owner&&u.role!=='super_admin'){for(const [label,body] of [[u.role==='admin'?'改为成员':'设为管理员',{role:u.role==='admin'?'member':'admin'}],[u.active?'停用':'启用',{active:!u.active}]]){const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{if(!confirm('确认'+label+' '+u.name+'？'))return;b.disabled=true;try{await api('/api/organization/users/'+encodeURIComponent(u.id),body);await load();}catch(e){error.textContent=e.message;b.disabled=false;}};ops.append(b);}}document.querySelector('#members').append(row);}}
  document.querySelector('#invite').onsubmit=async e=>{e.preventDefault();error.textContent='';const b=e.target.querySelector('button');b.disabled=true;try{const f=new FormData(e.target),v=await api('/api/organization/invitations',{email:f.get('email'),role:f.get('role')});document.querySelector('#message').textContent=location.origin+'/join#token='+v.token;}catch(e){error.textContent=e.message;}finally{b.disabled=false;}};
  load().catch(e=>error.textContent=e.message);
  </script></html>`,
  };
}
