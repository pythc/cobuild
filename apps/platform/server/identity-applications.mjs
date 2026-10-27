import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {REQUIREMENTS_BASE,LEGACY_REQUIREMENTS_BASE} from './requirements-endpoint.mjs';

export const IDENTITY_SCOPES=Object.freeze({
  'identity:profile':'姓名和组织身份',
  'identity:email':'企业邮箱',
  'identity:role':'工作台角色（不代表应用权限）',
});
const legacyServices={
  workbench:{name:'工作台',url:'/workbench',icon:'home'},
  projects:{name:'Kick · 项目',url:'/projects',icon:'folder'},honors:{name:'荣誉',url:'/honors',icon:'trophy'},
  recruitment:{name:'招新',url:'/recruitment',icon:'user'},mail:{name:'公共邮箱',url:'/mail',icon:'mail'},
  updates:{name:'动态',url:'/admin',icon:'apps'},assessment:{name:'Evalab · 考核管理',url:'https://exam.110-lab.cn/api/auth/feishu/start',icon:'file-check'},
  requirements:{name:'Makit · 需求平台',url:REQUIREMENTS_BASE,icon:'list-details'},
  knowledge:{name:'WeKnow · 知识库',url:'https://knowledge.110-lab.cn/home',icon:'book'},
};
export const SERVICES=Object.freeze(Object.fromEntries(Object.entries(legacyServices).map(([k,v])=>[k,Object.freeze(v)])));
const icons=new Set(['home','folder','trophy','user','mail','apps','file-check','list-details','book']);
const own=(object,key)=>Object.hasOwn(object,key);
function exactUrl(value,{localTest=false}={}){
  if(typeof value!=='string'||value.length>2048||/[\s\\\x00-\x1f]/.test(value))throw new Error('Invalid identity application URL');
  const u=new URL(value);
  const local=localTest&&u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&!!u.port;
  if((u.protocol!=='https:'&&!local)||u.username||u.password||u.hash||u.search||u.href!==value)throw new Error('Identity application URLs must be canonical HTTPS without queries or credentials');
  return value;
}
export function readIdentityApplications(filename){
  if(!filename)return [];
  const s=lstatSync(filename);
  if(!s.isFile()||s.isSymbolicLink()||s.size>65536||(s.mode&0o077))throw new Error('Unsafe identity application configuration');
  const value=JSON.parse(readFileSync(filename,'utf8'));
  if(!value||value.version!==1||!Array.isArray(value.applications)||Object.keys(value).some(k=>!['version','applications'].includes(k)))throw new Error('Invalid identity application configuration');
  return value.applications;
}
export function createIdentityRegistry({knowledgeCallback='http://127.0.0.1:5840/api/auth/identity/callback',applications=[],localTest=false,assessmentSsoEnabled=false}={}){
  if(!Array.isArray(applications)||applications.length>100)throw new Error('Invalid identity application list');
  const entries=new Map();
  // Legacy applications keep their original contracts, including loopback PKCE.
  entries.set('knowledge',Object.freeze({...SERVICES.knowledge,id:'knowledge',legacy:true,redirectUris:Object.freeze([knowledgeCallback]),scopes:Object.freeze(Object.keys(IDENTITY_SCOPES)),automatic:true}));
  entries.set('requirements',Object.freeze({...SERVICES.requirements,id:'requirements',legacy:true,
    redirectUris:Object.freeze(REQUIREMENTS_BASE===LEGACY_REQUIREMENTS_BASE?[]:[REQUIREMENTS_BASE+'/callback/110lab_requirements',REQUIREMENTS_BASE+'/callback/110lab_requirements/embedded']),
    scopes:Object.freeze(Object.keys(IDENTITY_SCOPES)),automatic:false,loopback:true}));
  for(const input of applications){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['id','name','url','icon','redirectUris','scopes'].includes(k)))throw new Error('Invalid identity application fields');
    const {id,name,url,redirectUris,scopes=['identity:profile'],icon='apps'}=input;
    if(typeof id!=='string'||! /^[a-z][a-z0-9-]{1,63}$/.test(id)||['constructor','prototype','__proto__'].includes(id)||own(SERVICES,id)||entries.has(id))throw new Error('Invalid or duplicate identity application ID');
    if(typeof name!=='string'||!name.trim()||name.length>80||/[\x00-\x1f]/.test(name)||!icons.has(icon))throw new Error('Invalid identity application presentation');
    exactUrl(url,{localTest});
    if(!Array.isArray(redirectUris)||!redirectUris.length||redirectUris.length>10||new Set(redirectUris).size!==redirectUris.length)throw new Error('Invalid identity callback list');
    redirectUris.forEach(value=>exactUrl(value,{localTest}));
    if(!Array.isArray(scopes)||!scopes.length||scopes.length>3||new Set(scopes).size!==scopes.length||!scopes.includes('identity:profile')||scopes.some(s=>!own(IDENTITY_SCOPES,s)))throw new Error('Invalid identity scopes');
    const entry={id,name:name.trim(),url,icon,redirectUris:Object.freeze([...redirectUris].sort()),scopes:Object.freeze([...scopes].sort()),automatic:false,legacy:false};
    entry.policyHash=createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    entries.set(id,Object.freeze(entry));
  }
  const get=id=>typeof id==='string'?entries.get(id):undefined;
  const allows=(id,value)=>{
    const app=get(id);if(!app||typeof value!=='string'||value.length>2048||/[\s\\\x00-\x1f]/.test(value))return false;
    try{const u=new URL(value);if(u.username||u.password||u.search||u.hash)return false;
      if(app.loopback)return app.redirectUris.includes(value)||(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.pathname==='/callback/110lab_requirements'&&!!u.port);
      return app.redirectUris.includes(value);
    }catch{return false;}
  };
  const services={...SERVICES,assessment:{...SERVICES.assessment,url:assessmentSsoEnabled?SERVICES.assessment.url:'https://exam.110-lab.cn/login'}};
  for(const [id,app]of entries)services[id]=Object.freeze({name:app.name,url:app.url,icon:app.icon,federated:true,scopes:app.scopes.map(id=>({id,label:IDENTITY_SCOPES[id]}))});
  return Object.freeze({get,allows,services:Object.freeze(services),project(profile,id){
    const app=get(id);if(!app)throw new Error('Unregistered identity application');
    if(app.legacy)return profile;
    const {issuer,subject,tenantKey,unionId,name,avatarUrl,authenticatedAt,expiresAt}=profile;
    return {issuer,subject,tenantKey,unionId,name,...(avatarUrl?{avatarUrl}:{}),authenticatedAt,expiresAt,scopes:[...app.scopes],...(app.scopes.includes('identity:email')?{email:profile.email}:{}),...(app.scopes.includes('identity:role')?{role:profile.role}:{})};
  }});
}
