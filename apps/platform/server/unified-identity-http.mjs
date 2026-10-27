import {isIP} from 'node:net';
import {readFile} from 'node:fs/promises';
import {openUnifiedIdentity,IDENTITY_ISSUER} from './unified-identity.mjs';
import {createIdentityRegistry,readIdentityApplications} from './identity-applications.mjs';
import {MailAuthError} from './mail-auth.mjs';
import {ADMIN_FRAME_ANCESTORS} from './admin-http.mjs';
import {readFileSync,lstatSync} from 'node:fs';
import {REQUIREMENTS_BASE as REQUIREMENTS_ORIGIN} from './requirements-endpoint.mjs';
function requirementsKey(options){
  if(options.localTest&&options.requirementsKey)return options.requirementsKey;
  const path=process.env.PORTAL_REQUIREMENTS_IDENTITY_CONFIG;
  if(!path)throw new MailAuthError(503,'需求平台统一连接尚未配置');
  const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||s.size>8192)throw new MailAuthError(503,'需求平台连接配置无效');
  const v=JSON.parse(readFileSync(path,'utf8'));if(typeof v.openApiKey!=='string'||!v.openApiKey||v.openApiKey.length>4096||!/^[\x21-\x7e]+$/.test(v.openApiKey))throw new MailAuthError(503,'需求平台连接配置无效');return v.openApiKey;
}
export async function createUnifiedIdentityHttp(options){
  const html=await readFile(new URL('../dist/identity.html',import.meta.url),'utf8');
  const registry=createIdentityRegistry({...options,applications:options.applications??readIdentityApplications(process.env.PORTAL_IDENTITY_APPLICATIONS_CONFIG)});
  const store=options.enabled?openUnifiedIdentity({...options,registry}):null;
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));};
  async function read(req){if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new MailAuthError(415,'请求格式无效');let size=0,parts=[];const timeout=setTimeout(()=>req.destroy(),8000);timeout.unref();try{for await(const p of req){size+=p.length;if(size>8192)throw new MailAuthError(413,'请求过长');parts.push(p);}const value=JSON.parse(Buffer.concat(parts));if(!value||typeof value!=='object'||Array.isArray(value))throw new MailAuthError(400,'请求无效');return value;}catch(e){if(e instanceof MailAuthError)throw e;throw new MailAuthError(400,'请求无效');}finally{clearTimeout(timeout);}}
  return {finish:(...args)=>store?.finish(...args)||false,close(){store?.close();},async handle(req,res,path,host){
    const embedded=path==='/auth/embedded'||path.startsWith('/api/identity/embedded/');
    if(embedded&&path.startsWith('/api/identity/embedded/'))path=path.replace('/api/identity/embedded/','/api/identity/');
    if(path!=='/auth/embedded'&&path!=='/auth'&&path!=='/auth/'&&!path.startsWith('/api/identity/'))return false;
    try{
      if(host!=='internal.110-lab.cn'&&!(options.localTest&&host==='127.0.0.1'))throw new MailAuthError(404,'页面不存在');
      if(['GET','HEAD'].includes(req.method)&&['/auth','/auth/','/auth/embedded'].includes(path)){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex,nofollow','Content-Security-Policy':`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https://*.feishucdn.com data:; connect-src 'self'; frame-ancestors ${embedded?"'self' "+ADMIN_FRAME_ANCESTORS.join(' '):"'none'"}; form-action 'self'; base-uri 'none'`});res.end(req.method==='HEAD'?undefined:html);return true;
      }
      // Only browser consent is available in the embedded namespace. Never alias
      // login/logout or machine credential endpoints into this cookie context.
      if(embedded&&!['config','session','validate','continuation','authorize'].some(a=>path==='/api/identity/'+a))throw new MailAuthError(404,'页面不存在');
      if(path==='/api/identity/config'&&req.method==='GET'){json(res,200,{enabled:!!store,services:registry.services});return true;}
      if(!store)throw new MailAuthError(503,'登录暂时不可用');
      if(req.method==='GET'&&path==='/api/identity/session'){json(res,200,await store.session(req.headers.cookie,{embedded}));return true;}
      if(req.method!=='POST')throw new MailAuthError(405,'请求方式无效');
      const requirementAction=['connect','ticket'].find(v=>path==='/api/identity/requirements/'+v);
      if(requirementAction){
        if(req.headers.origin||req.headers['sec-fetch-site'])throw new MailAuthError(403,'仅供客户端连接使用');
        const input=await read(req),keys=requirementAction==='connect'?['token']:['token','publicKey','requestNonce','state','redirectUri'];
        if(!input||Object.keys(input).some(k=>!keys.includes(k)))throw new MailAuthError(400,'请求无效');
        await store.inspect({audience:'requirements',token:input.token});
        const fetcher=options.localTest&&options.requirementsFetch||fetch;
        let response;try{response=await fetcher(REQUIREMENTS_ORIGIN+'/openapi/identity/'+requirementAction,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+requirementsKey(options)},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new MailAuthError(503,'暂时无法连接需求平台');}
        if(!response.ok){await response.body?.cancel();throw new MailAuthError([401,403,410,412].includes(response.status)?response.status:503,response.status===412?'首次平台连接尚未完成':response.status===410?'需求连接已停用':'暂时无法完成需求连接');}
        let n=0,parts=[];for await(const p of response.body){if((n+=p.length)>32768)throw new MailAuthError(503,'需求连接响应无效');parts.push(p);}
        json(res,200,JSON.parse(Buffer.concat(parts)));return true;
      }
      if(path==='/api/identity/navigation'){
        if(req.headers.origin||req.headers['sec-fetch-site'])throw new MailAuthError(403,'仅供服务连接使用');
        const input=await read(req);
        if(Object.keys(input).sort().join(',')!=='audience,token'||input.audience!=='relay')throw new MailAuthError(400,'请求无效');
        const actor=await store.inspect(input);
        if(!options.navigation)throw new MailAuthError(503,'收藏服务暂时不可用');
        const value=await options.navigation(actor);
        if(!value)throw new MailAuthError(503,'收藏服务暂时不可用');
        json(res,200,value);return true;
      }
      const back=['exchange','inspect','revoke'].find(v=>path==='/api/identity/'+v);
      if(back){if(req.headers.origin||req.headers['sec-fetch-site'])throw new MailAuthError(403,'仅供服务连接使用');const input=await read(req);const keys=back==='exchange'?['audience','code','state','verifier','redirectUri']:['audience','token'];if(Object.keys(input).some(k=>!keys.includes(k)))throw new MailAuthError(400,'请求无效');json(res,200,await store[back](input)||{revoked:true});return true;}
      const origin=options.localTest?'http://'+req.headers.host:IDENTITY_ISSUER;
      if(req.headers.origin!==origin||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')throw new MailAuthError(403,'请在登录页面操作');
      const input=await read(req);
      if(path==='/api/identity/login'){if(Object.keys(input).some(k=>k!=='next'))throw new MailAuthError(400,'请求无效');const result=store.start(req.headers.cookie,input.next,options.trustedProxies?.includes(req.socket.remoteAddress)&&isIP(String(req.headers['x-forwarded-for']||'').split(',')[0].trim())?String(req.headers['x-forwarded-for']).split(',')[0].trim():req.socket.remoteAddress);res.setHeader('Set-Cookie',result.cookie);json(res,200,{launchUrl:result.launchUrl});return true;}
      if(path==='/api/identity/logout'){if(Object.keys(input).length)throw new MailAuthError(400,'请求无效');res.setHeader('Set-Cookie',store.logout(req.headers.cookie,req.headers['x-csrf-token']));json(res,200,{loggedOut:true});return true;}
      const action=['authorize','continuation','validate'].find(v=>path==='/api/identity/'+v);
      if(action){if(embedded&&(input.audience!=='requirements'||input.redirectUri!==REQUIREMENTS_ORIGIN+'/callback/110lab_requirements/embedded'))throw new MailAuthError(400,'连接请求无效，请从应用重新发起');if(Object.keys(input).some(k=>!['audience','redirectUri','state','challenge'].includes(k)))throw new MailAuthError(400,'请求无效');json(res,200,action==='validate'?store.validate(input):await store[action](req.headers.cookie,req.headers['x-csrf-token'],input,{embedded}));return true;}
      throw new MailAuthError(404,'页面不存在');
    }catch(e){req.resume();if(!res.headersSent)json(res,e instanceof MailAuthError?e.status:503,{error:e instanceof MailAuthError?e.message:'暂时无法完成登录'});return true;}
  }};
}
