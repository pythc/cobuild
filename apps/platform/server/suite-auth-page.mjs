import { randomBytes } from "node:crypto";
import { escapeHTML as e } from "./render.mjs";
export function suiteAuthPage(
  config,
  mode,
  { next = "/workbench", consent } = {},
) {
  const nonce = randomBytes(18).toString("base64url");
  const title =
    mode === "reset" ? "重设密码" : mode === "setup"
      ? "创建你的协作空间"
      : mode === "join"
        ? "加入团队"
        : mode === "consent"
          ? "连接应用"
          : "登录 CoBuild";
  const fields =
    mode === "consent"
      ? `<p>将使用当前 CoBuild 身份连接 <strong>${e(consent.name)}</strong>。各应用的数据权限仍独立检查。</p>`
      : `${mode === "setup" ? '<label>初始化凭据<input name="bootstrap" type="password" autocomplete="off" required></label>' : ""}${["setup","join"].includes(mode) ? '<label>姓名<input name="name" autocomplete="name" maxlength="100" required></label>' : ""}${["setup","login"].includes(mode) ? '<label>邮箱<input name="email" type="email" autocomplete="username" maxlength="254" required></label>' : ""}<label>密码<input name="password" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="12" maxlength="128" required></label>`;
  const data = JSON.stringify({ mode, next, consent }).replaceAll(
    "<",
    "\\u003c",
  );
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)} · CoBuild</title><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f5f7fb;color:#202634;font:15px/1.6 system-ui,sans-serif;display:grid;place-items:center;padding:32px 20px}main{width:min(100%,440px);background:white;border:1px solid #e3e8f0;border-radius:20px;padding:36px;box-shadow:0 12px 48px #24336b0a}.brand{font-size:21px;font-weight:800;color:#2447c7;letter-spacing:-.7px}h1{font-size:25px;line-height:1.35;margin:24px 0 8px}.org{color:#687387;margin:0 0 24px;overflow-wrap:anywhere}label{display:block;font-weight:600;margin:18px 0}input{display:block;width:100%;margin-top:7px;border:1px solid #cdd5e1;border-radius:9px;padding:12px;font:inherit}input:focus{outline:3px solid #dce5ff;border-color:#3456db}button{width:100%;padding:12px;margin-top:12px;background:#3653d9;color:white;border:0;border-radius:9px;font:600 15px system-ui;cursor:pointer}button:disabled{opacity:.6}#message{color:#b53545;min-height:24px;margin-bottom:0}a{color:#3653d9}small{display:block;color:#687387;margin-top:18px}</style><main><div class="brand">CoBuild</div><h1>${e(title)}</h1><p class="org">${e(config.organization.name)}</p><form id="form">${fields}<button>${mode === "reset" ? "保存新密码" : mode === "consent" ? "确认连接" : mode === "setup" ? "创建并进入" : mode === "join" ? "加入并登录" : "登录"}</button></form><p id="message" role="status" aria-live="polite"></p><small>${mode === "setup" ? "初始化凭据保存在部署机器的私有数据目录。" : `<a href="/workbench">返回工作台</a>${mode === "login" ? " · 忘记密码请联系组织管理员获取恢复链接。" : ""}`}</small></main><script nonce="${nonce}">const state=${data};let invite=new URLSearchParams(location.hash.slice(1)).get('token');if(invite)history.replaceState(null,'',location.pathname);document.querySelector('#form').onsubmit=async event=>{event.preventDefault();const button=document.querySelector('button'),message=document.querySelector('#message');button.disabled=true;message.textContent='';try{const fields=Object.fromEntries(new FormData(event.target));let path,headers={'content-type':'application/json'},input;if(state.mode==='consent'){const s=await fetch('/api/identity/session',{credentials:'same-origin',cache:'no-store'});const profile=await s.json();if(!s.ok)throw Error(profile.error||'请重新登录');headers['x-csrf-token']=profile.csrf;path='/api/identity/authorize';input={audience:state.consent.audience,redirectUri:state.consent.redirectUri,state:state.consent.state,challenge:state.consent.challenge};}else{path='/api/auth/'+(state.mode==='reset'?'reset-password':state.mode==='setup'?'bootstrap':state.mode==='join'?'accept':'login');if(state.mode==='setup'){headers['x-bootstrap-token']=fields.bootstrap;delete fields.bootstrap;}if(['join','reset'].includes(state.mode))fields.token=invite;input=fields;}const response=await fetch(path,{method:'POST',credentials:'same-origin',headers,body:JSON.stringify(input)}),value=await response.json();if(!response.ok)throw Error(value.error||'暂时无法完成操作');location.assign(state.mode==='reset'?'/login':value.redirectUrl||state.next);}catch(error){message.textContent=error.message||'暂时无法完成操作';button.disabled=false;}};</script></html>`;
  return {
    html,
    csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  };
}
