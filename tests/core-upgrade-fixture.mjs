import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const cfg=JSON.parse(readFileSync(process.env.COBUILD_CONFIG)),base=cfg.origins.platform;
const path=process.env.COBUILD_FLOW_RECEIPT,seed=process.argv.includes('--seed');
const saved=seed?{}:JSON.parse(readFileSync(path)),jars=new Map(saved.cookies||[]);
let checks=0;
function check(v,label){assert.ok(v,label);checks++;}
async function req(url,body,headers={}) {
 const origin=new URL(url).origin,jar=new Map(jars.get(origin)||[]);
 const r=await fetch(url,{redirect:'manual',method:body?'POST':'GET',headers:{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...(body?{Origin:origin,...(body instanceof FormData?{}:{'Content-Type':'application/json'})}:{}),...headers},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
 for(const c of r.headers.getSetCookie()){const p=c.split(';')[0],i=p.indexOf('=');jar.set(p.slice(0,i),p.slice(i+1));}jars.set(origin,[...jar]);
 const text=await r.text();let data;try{data=JSON.parse(text);data=data.data||data;}catch{}
 return {status:r.status,data,text,headers:r.headers};
}
const post=(p,b)=>req(base+p,b,{'X-CSRF-Token':saved.csrf});
async function project(name){
 let r=await post('/api/workspace/projects',{requestId:randomUUID(),name,summary:'Isolated upgrade fixture',members:[],links:{repository:'',requirements:'',docs:'',demo:''},createKnowledgeSpace:true});
 check(r.status===201,'create project');const id=r.data.id;
 r=await post('/api/workspace/projects/'+id+'/apply',{revision:r.data.revision,application:'Upgrade rehearsal'});check(r.status===200,'apply');
 r=await req(base+'/api/workspace/projects/'+id);
 r=await post('/api/workspace/projects/'+id+'/review',{revision:r.data.revision,decision:'approve',note:''});check(r.status===200,'approve');
 for(let n=0;n<160;n++){
  r=await req(base+'/api/workspace/projects/'+id);
  if(r.data.knowledgeSpace.state==='ready'&&r.data.requirementsSync.state==='synced')return r.data;
  await new Promise(r=>setTimeout(r,250));
 }throw Error('Project did not settle');
}
if(seed){
 const r=await req(base+'/api/auth/bootstrap',{email:'upgrade@example.test',name:'Upgrade Owner',password:'Isolated upgrade password 123'}, {'X-Bootstrap-Token':readFileSync(process.env.COBUILD_DATA_DIR+'/bootstrap.private.key','utf8').trim()});
 check(r.status===200,'bootstrap baseline');saved.csrf=r.data.csrf;
 const f=await req(cfg.origins.weknow+'/api/auth/identity/login');const u=new URL(f.headers.get('location'));
 const a=await post('/api/identity/authorize',{audience:'knowledge',redirectUri:u.searchParams.get('redirect_uri'),state:u.searchParams.get('state'),challenge:u.searchParams.get('code_challenge')});
 check(a.status===200,'baseline identity authorize');
 check([302,303].includes((await req(a.data.redirectUrl)).status),'baseline callback');
 saved.project=await project('Legacy project before upgrade');
 const p=await req(cfg.origins.weknow+'/api/pages/create',{spaceId:saved.project.knowledgeSpace.spaceId,title:'Preserved baseline document',content:'# Preserve\n\nExisting project data.',format:'markdown'});
 check(p.status===200,'baseline document');saved.pageId=p.data.id;
 const fdata=new FormData();fdata.append('pageId',p.data.id);fdata.append('file',new Blob(['retained attachment bytes'],{type:'text/plain'}),'retained.txt');
 const file=await req(cfg.origins.weknow+'/api/files/upload',fdata);check(file.status===200,'baseline attachment');saved.fileId=file.data.id;
} else {
 check((await req(base+'/api/auth/session')).status===200,'platform login retained');
 const p=await req(base+'/api/workspace/projects/'+saved.project.id);check(p.status===200 && p.data.knowledgeSpace.spaceId===saved.project.knowledgeSpace.spaceId,'stable project and legacy mapping retained');
 const oldPage=await req(cfg.origins.weknow+'/api/pages/info',{pageId:saved.pageId});
 check(oldPage.data?.title==='Preserved baseline document','legacy document and session retained '+oldPage.status+' '+JSON.stringify(oldPage.data));
 const f=await req(cfg.origins.weknow+'/api/files/'+saved.fileId+'/retained.txt');check(f.status===200&&f.text==='retained attachment bytes','attachment metadata and bytes retained');
 if(!saved.newProject){
  saved.newProject=await project('Managed project after upgrade');
  const page=await req(cfg.origins.weknow+'/api/pages/create',{spaceId:saved.newProject.knowledgeSpace.spaceId,title:'Created after migration'});check(page.status===200,'write after migration');saved.newPage=page.data.id;
 }
 check((await req(cfg.origins.weknow+'/api/pages/info',{pageId:saved.newPage})).status===200,'post-upgrade write retained');
 const op=await post('/api/workspace/projects/'+saved.project.id+'/rename',{requestId:randomUUID(),revision:p.data.revision,name:'Renamed legacy project'});
 // A retry verification may find no name change, which still creates a durable command receipt.
 check(op.status===200,'new command route available');
 check(!!op.data.operation?.id,'new operation ledger committed');
}
saved.cookies=[...jars];writeFileSync(path,JSON.stringify(saved),{mode:0o600});
console.log(JSON.stringify({passed:true,checks,scope:seed?'baseline seed':'upgrade persistence'}));
