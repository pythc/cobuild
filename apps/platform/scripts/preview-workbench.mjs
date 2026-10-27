// Local visual acceptance with fictional users. Never included in releases.
import {createServer,request} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHttpServer} from '../server/http.mjs';
import {openWorkspaceStore} from '../server/workspace-store.mjs';
import {fixtureConfig,fixtureIdentity} from '../tests/helpers/mail-fixtures.mjs';
const directory=await mkdtemp(join(tmpdir(),'cobuild-workbench-preview-'));
const owner={...fixtureIdentity,name:'示例管理员'},member={subject:'fictional_tenant:on_preview_member',name:'示例成员',email:'preview.member@110-lab.cn'};
const todoFixtures=[
  {kind:'honor',id:'fixture-honor-one',title:'智能应用实践成果登记',status:'待审核',projectName:'智能应用实践'},
  {kind:'honor',id:'fixture-honor-two',title:'产品原型设计成果登记',status:'待审核',projectName:'产品原型设计'},
];
const backend=await createHttpServer({liveReload:true,applicationAccess:{fetchSnapshot:async()=>({members:[owner,member],departments:[{id:"od-preview-dev",name:"开发组",path:"110 实验室 / 开发组",parentId:"0",subjects:[member.subject]}],syncedAt:Date.now()})},mail:{enabled:true,directory,config:fixtureConfig,localTest:true,fetchIdentity:async(_,{code})=>code==='member'?member:owner,fetchDirectory:async()=>[owner,member]},workspace:{localTest:true,projectSyncEnabled:false,honorsTodos:actor=>actor.role==='super_admin'?todoFixtures:[]}});
await new Promise(r=>backend.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+backend.address().port;
const cookie=response=>response.headers.getSetCookie()[0]?.split(';')[0]||'';
async function call(path,{jar='',data}={}){return fetch(base+path,{method:data===undefined?'GET':'POST',redirect:'manual',headers:{Origin:base,Cookie:jar,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});}
async function login(persona){
  const start=await call('/api/mail/auth/start',{data:{}}),value=await start.json(),binding=cookie(start);
  const launch=await call('/mail/auth/launch?state='+value.state),callback=await call('/mail/auth/callback?state='+value.state+'&code='+persona,{jar:cookie(launch)});
  const html=await callback.text(),ticket=html.match(/<code>([\w-]{43})<\/code>/)?.[1];if(!ticket)throw new Error('Fixture login failed');
  const redeemed=await call('/api/mail/auth/redeem',{jar:binding,data:{state:value.state,ticket}});if(!redeemed.ok)throw new Error('Fixture login failed');return cookie(redeemed);
}
const seed=openWorkspaceStore({directory:join(directory,'workspace')});
const actor={...owner,role:'super_admin'};
for(const [name,summary] of [['智能应用实践','完成产品原型与使用流程'],['文档检索项目','实现文档上传与搜索体验']]){
  const project=seed.create(actor,{name,summary,members:[member],links:{repository:'',docs:'',demo:'',requirements:''}});
  seed.addMilestone(actor,project.id,{title:'完成原型与交互验证',assignee:actor.subject,dueAt:new Date(Date.now()+86400000).toISOString()});
}
seed.close();
let fixtureCookieName,previewBuild=null;
// Local-only release fixtures exercise reminders without changing production.

const frontend=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/preview-release/')){
    const scenario=url.pathname.split('/').at(-1);
    if(!['current','available','next'].includes(scenario)){res.writeHead(404);res.end();return;}
    previewBuild=scenario==='current'?null:(scenario==='available'?'b':'c').repeat(64);
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('Local release fixture: '+scenario);return;
  }
  if(url.pathname==='/api/plugin/release'&&previewBuild&&req.method==='GET'){
    const response=await fetch(base+'/api/plugin/release'),value=await response.json();
    res.writeHead(response.status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({...value,workbenchBuild:previewBuild}));return;
  }
  if(url.pathname.startsWith('/preview-user/')){
    try{const persona=url.pathname.split('/').at(-1);if(!['owner','member','none'].includes(persona)){res.writeHead(404);res.end();return;}
      const value=persona==='none'?fixtureCookieName+'=; Path=/; Max-Age=0; SameSite=Lax':await login(persona);
      if(persona!=='none')fixtureCookieName=value.split('=')[0];
      res.writeHead(303,{'Set-Cookie':persona==='none'?value:value+'; Path=/; HttpOnly; SameSite=Lax',Location:'/workbench','Cache-Control':'no-store'});res.end();
    }catch{res.writeHead(500);res.end('Local fixture unavailable');}return;
  }
  const proxy=request(base+req.url,{method:req.method,headers:req.headers},upstream=>{res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);});
  proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(proxy);
});
const port=Number(process.env.PORTAL_PREVIEW_PORT||5398);
await new Promise((resolve,reject)=>{frontend.once('error',reject);frontend.listen(port,'127.0.0.1',resolve);});
console.log('CoBuild preview: http://127.0.0.1:'+port+'/preview-user/owner');
console.log('Switch identity: /preview-user/member or /preview-user/none (fictional users only)');
async function stop(){await new Promise(r=>frontend.close(r));await new Promise(r=>backend.close(r));await rm(directory,{recursive:true,force:true});process.exit(0);}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
