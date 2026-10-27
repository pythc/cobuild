import {timingSafeEqual} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {z} from 'zod';
import {ADMIN_FRAME_ANCESTORS} from './admin-http.mjs';
import {ApplicationAccessError} from './application-access.mjs';
const entryRoute=/^\/(?:api\/application-access\/(embedded\/)?entry|apps\/enter)\/([a-z][a-z0-9-]{0,63})$/;
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'});res.end(JSON.stringify(value));};
export function protectedApplication(path){
  if(/^\/monitoring(\/|$)/.test(path)||path.startsWith('/api/monitoring/'))return 'monitoring';
  if(/^\/(projects)(\/|$)/.test(path)||/^\/api\/workspace\/(embedded\/)?projects(\/|$)/.test(path))return 'projects';
  if(/^\/honors(\/|$)/.test(path)||path.startsWith('/api/honors/'))return 'honors';
  if(/^\/recruitment(?:-test)?(\/|$)/.test(path)||/^\/api\/recruitment-(admin|interviewer|test)\//.test(path)||/^\/api\/workspace\/(embedded\/)?recruitment\//.test(path))return 'recruitment-test';
  if(/^\/organization(\/|$)/.test(path))return 'organization';
  if(/^\/sso\/assessment/.test(path))return 'assessment';
  if(/^\/admin(\/|$)/.test(path)||path.startsWith('/api/admin/'))return 'updates-admin';
  // Keep shared login, session, configuration and role administration reachable.
  if(/^\/mail\/?$|^\/mail\/embedded$/.test(path)||/^\/api\/mail\/(embedded\/)?notify$/.test(path))return 'public-mail';
  return null;
}
export function createApplicationAccessHttp({mail,access,apps,localTest=false}){
  async function handle(req,res,path,host){
    if(!access||host!=='internal.110-lab.cn'&&!(localTest&&['localhost','127.0.0.1'].includes(host)))return false;
    if(path==='/api/application-access/service/relay'){
      try{
        if(req.method!=='POST'||req.headers.origin||req.headers['sec-fetch-site'])throw new ApplicationAccessError(403,'服务请求无效');
        const filename=process.env.PORTAL_RELAY_ACCESS_KEY_FILE;
        if(!filename)throw new ApplicationAccessError(503,'Relay 服务权限尚未配置');
        const st=lstatSync(filename);if(!st.isFile()||st.isSymbolicLink()||st.size>256||st.mode&0o077)throw new ApplicationAccessError(503,'Relay 服务权限配置无效');
        const key=readFileSync(filename,'utf8').trim(),given=req.headers['x-relay-access-key'];
        if(key.length<32||typeof given!=='string'||Buffer.byteLength(given)!==Buffer.byteLength(key)||!timingSafeEqual(Buffer.from(given),Buffer.from(key)))throw new ApplicationAccessError(401,'服务身份无效');
        if(req.headers['content-type']!=='application/json')throw new ApplicationAccessError(415,'请求格式无效');
        let n=0,parts=[];const timer=setTimeout(()=>req.destroy(),5000);timer.unref();let input;
        try{for await(const part of req){if((n+=part.length)>1024)throw new ApplicationAccessError(413,'请求过长');parts.push(part);}input=JSON.parse(Buffer.concat(parts));}finally{clearTimeout(timer);}
        const v=z.object({employeeId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}).strict().parse(input);
        json(res,200,await access.relayOperator(v.employeeId));
      }catch(e){req.resume();if(!res.headersSent)json(res,e.status||503,{error:'暂时无法核对客服权限'});}return true;
    }
    const match=/^\/api\/organization\/(embedded\/)?app-access(?:\/([a-z][a-z0-9-]{0,63}))?$/.exec(path);
    const frameEntry=/^\/apps\/embedded\/([a-z][a-z0-9-]{0,63})$/.exec(path);
    const entry=entryRoute.exec(path)||(frameEntry&&[frameEntry[0],'embedded/',frameEntry[1]]);
    const entries=/^\/api\/application-access\/(embedded\/)?entries$/.exec(path);
    try{
      if(entry){if(!['GET','HEAD'].includes(req.method))throw new ApplicationAccessError(405,'请求方式无效');const app=apps.find(a=>a.id===entry[2]);if(!app)throw new ApplicationAccessError(404,'应用不存在');
        const embedded=!!entry[1]||new URL(req.url,'http://localhost').searchParams.get('embedded')==='1';let actor=null;try{actor=mail.identity(req,{embedded});}catch(e){if(e.status!==401||access.policy(app.id).mode!=='inherit')throw e;}await access.authorize(actor,app.id);
        if(path.startsWith('/api/'))json(res,200,{allowed:true,id:app.id,url:app.url});else{let target=app.url;if(frameEntry){if(['projects','honors','recruitment-test','organization','public-mail','updates-admin'].includes(app.id))target=app.url.replace(/\/$/,'')+'/embedded';else if(app.id==='assessment')target='https://exam.110-lab.cn/api/auth/feishu/start?embedded=1';if(app.id==='honors'){const record=new URL(req.url,'http://localhost').searchParams.get('record');if(record&&z.uuid().safeParse(record).success)target+='?record='+encodeURIComponent(record);}}res.writeHead(302,{Location:target,'Cache-Control':'private, no-store'});res.end();}return true;}
      if(entries&&req.method==='GET'){let actor=null;try{actor=mail.identity(req,{embedded:!!entries[1]});}catch(e){if(e.status!==401)throw e;}json(res,200,{...await access.entries(actor),subject:actor?.subject||null});return true;}
      if(match){const embedded=!!match[1],write=req.method==='POST';if(!['GET','POST'].includes(req.method))throw new ApplicationAccessError(405,'请求方式无效');
        let actor=mail.identity(req,{embedded,write});if(actor.role!=='super_admin')throw new ApplicationAccessError(403,'仅超级管理员可配置应用权限');
        if(!write&&!match[2]){json(res,200,await access.manage(actor));return true;}
        if(!write||!match[2])throw new ApplicationAccessError(404,'接口不存在');
        if(req.headers.origin!==(localTest?'http://'+req.headers.host:'https://internal.110-lab.cn')||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')throw new ApplicationAccessError(403,'请在组织与权限页面操作');
        if(req.headers['content-type']!=='application/json')throw new ApplicationAccessError(415,'请求格式无效');
        let size=0,parts=[];const timeout=setTimeout(()=>req.destroy(),8000);timeout.unref();let value;try{for await(const c of req){if((size+=c.length)>65536)throw new ApplicationAccessError(413,'内容过长');parts.push(c);}value=JSON.parse(Buffer.concat(parts));}finally{clearTimeout(timeout);}
        if(match[2]==='directory'){if(!value||Object.keys(value).length)throw new ApplicationAccessError(400,'参数无效');await access.refresh({fresh:true});actor=mail.identity(req,{embedded,write:true});json(res,200,await access.manage(actor));return true;}
        if(value?.policy?.mode!=='inherit')await access.refresh({fresh:true});
        actor=mail.identity(req,{embedded,write:true});mail.recentIdentity(req,{embedded});json(res,200,access.update(actor,match[2],value));return true;
      }
      const id=protectedApplication(path);if(!id||access.policy(id).mode==='inherit')return false;
      const embedded=path.endsWith('/embedded')||path.includes('/embedded/');const actor=mail.identity(req,{embedded});await access.authorize(actor,id);req.applicationAccessId=id;mail.identity(req,{embedded});return false;
    }catch(e){req.resume();if(res.headersSent)return true;const status=e instanceof z.ZodError||e instanceof SyntaxError?400:e.status||503,message=e.status?e.message:status===400?'参数无效':'应用访问权限暂时无法核对';
      if(path.startsWith('/api/'))json(res,status,{error:message,code:e.code||'APP_ACCESS_UNAVAILABLE'});
      else{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Content-Security-Policy':`default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self' ${ADMIN_FRAME_ANCESTORS.join(' ')}`});const escaped=message.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');res.end('<!doctype html><meta charset="utf-8"><title>应用访问权限 · CoBuild</title><style>body{font:15px/1.8 system-ui;padding:48px;color:#20242c}a{color:#2446bd}</style><h1>暂时无法进入此应用</h1><p>'+escaped+'</p><a href="'+(path.includes('/embedded')?'/workbench/embedded':'/workbench')+'">返回工作台</a>');}return true;}
  }
  return {handle};
}
