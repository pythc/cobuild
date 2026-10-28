import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const config=JSON.parse(readFileSync(process.env.COBUILD_CONFIG)),
  flow=JSON.parse(readFileSync(process.env.COBUILD_FLOW_RECEIPT)),
  path=process.env.COBUILD_ATTACHMENT_RECEIPT,
  seed=process.argv.includes('--seed'), jars=new Map();
let checks=0;
async function request(url, body) {
  const origin=new URL(url).origin,jar=jars.get(origin)||new Map();
  const r=await fetch(url,{redirect:'manual',method:body?'POST':'GET',headers:{
    Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),
    ...(body?{Origin:origin}:{}),
    ...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{}),
  },body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  for(const c of r.headers.getSetCookie()) { const pair=c.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1)); }
  jars.set(origin,jar);
  const text=await r.text();let data;try{data=JSON.parse(text);data=data.data||data;}catch{}
  return {status:r.status,data,text,headers:r.headers};
}
function check(v,label){assert.ok(v,label);checks++;}
let saved=seed?{}:JSON.parse(readFileSync(path));
if(!seed) for(const [origin,entries] of saved.cookies)jars.set(origin,new Map(entries));
const base=config.origins.platform;
if(seed){
  let r=await request(base+'/api/auth/login',{email:'member@example.test',password:'Recovered member local password 123'});
  check(r.status===200,'owner authenticates for attachment fixture');const csrf=r.data.csrf;
  r=await request(config.origins.weknow+'/api/auth/identity/login');
  const url=new URL(r.headers.get('location'));
  // Include the central CSRF token in a genuine authorization request.
  const jar=jars.get(base), response=await fetch(base+'/api/identity/authorize',{method:'POST',headers:{
    Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf,Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')
  },body:JSON.stringify({audience:'knowledge',redirectUri:url.searchParams.get('redirect_uri'),state:url.searchParams.get('state'),challenge:url.searchParams.get('code_challenge')})});
  const data=await response.json();check(response.ok,'attachment authorization granted');
  r=await request(data.redirectUrl);check([302,303].includes(r.status),'attachment session established');
  const content='CoBuild attachment backup fixture\n'+flow.projectId+'\n', form=new FormData();
  form.append('pageId',flow.pageId);form.append('file',new Blob([content],{type:'text/plain'}),'recovery-proof.txt');
  r=await request(config.origins.weknow+'/api/files/upload',form);
  check(r.status===200 && r.data.id,'attachment uploaded '+r.status);
  const fileUrl=config.origins.weknow+'/api/files/'+r.data.id+'/recovery-proof.txt';
  saved={url:fileUrl,sha256:createHash('sha256').update(content).digest('hex'),cookies:[...jars].map(([o,j])=>[o,[...j]])};
  writeFileSync(path,JSON.stringify(saved),{mode:0o600});
}
let r=await request(base+'/api/auth/session');check(r.status===200 && r.data.role==='super_admin','platform session and role survive');
if(process.argv.includes('--add-page')) {
  r=await request(config.origins.weknow+'/api/pages/create',{spaceId:flow.spaceId,title:'Created after upgrade'});
  check(r.status===200 && r.data.id,'write a real document after upgrade');saved.newPage=r.data.id;
  writeFileSync(path,JSON.stringify(saved),{mode:0o600});
}
if(saved.newPage) {
  r=await request(config.origins.weknow+'/api/pages/info',{pageId:saved.newPage});
  check(r.status===200 && r.data.title==='Created after upgrade','rollback preserves new database writes');
}
r=await request(saved.url);check(r.status===200,'attachment metadata and stored object survive '+r.status);
check(createHash('sha256').update(r.text).digest('hex')===saved.sha256,'attachment bytes remain identical');
console.log(JSON.stringify({passed:true,checks,scope:seed?'attachment seed':'persisted session and attachment'}));
