import {lstatSync,readFileSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createKnowledgeTransport} from './project-knowledge-transport.mjs';
const ORIGIN='https://knowledge.110-lab.cn';
export class KnowledgeProjectError extends Error {
  constructor(code,{permanent=false}={}){super(code);this.code=code;this.permanent=permanent;}
}
export function createProjectKnowledgeClient({configPath=process.env.PORTAL_PROJECT_KNOWLEDGE_CONFIG,fetcher=createKnowledgeTransport()}={}){
  function load(){try{const s=lstatSync(configPath);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||s.size>32768)throw new Error();
    const v=JSON.parse(readFileSync(configPath,'utf8'));if(typeof v.accessToken!=='string'||!v.accessToken||/[\r\n]/.test(v.accessToken))throw new Error();return v;
  }catch{throw new KnowledgeProjectError('KNOWLEDGE_NOT_CONFIGURED',{permanent:true});}}
  function save(config){const tmp=configPath+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(config),{mode:0o600,flag:'wx'});const fd=openSync(tmp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,configPath);}
  async function refresh(previous){
    const path=configPath+'.refresh.lock',token=randomUUID(),deadline=Date.now()+20000;
    for(;;){
      try{writeFileSync(path,JSON.stringify({token,expires:Date.now()+90000}),{mode:0o600,flag:'wx'});break;}
      catch(error){
        if(error.code!=='EEXIST')throw new KnowledgeProjectError('KNOWLEDGE_UNCONFIRMED');
        try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>1024)throw new Error();
          let lock;try{lock=JSON.parse(readFileSync(path));}catch{ /* The owner may still be writing the new lock. */ }
          if(lock?.expires<Date.now())throw new KnowledgeProjectError('KNOWLEDGE_RECONNECT_REQUIRED',{permanent:true});
        }catch(error){if(error.code==='ENOENT')continue;throw error instanceof KnowledgeProjectError?error:new KnowledgeProjectError('KNOWLEDGE_REFRESH_LOCK_INVALID',{permanent:true});}
        if(Date.now()>deadline)throw new KnowledgeProjectError('KNOWLEDGE_REFRESH_BUSY');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
    try{
      let config=load();
      if(config.refreshPending)throw new KnowledgeProjectError('KNOWLEDGE_RECONNECT_REQUIRED',{permanent:true});
      if(config.accessToken!==previous.accessToken)return config;
      // A crash or lost refresh response must never cause reuse of a possibly consumed grant.
      config={...config,refreshPending:token};save(config);
      const refreshed=await json(ORIGIN+'/api/knowledge/oauth/token',{grant_type:'refresh_token',refresh_token:config.refreshToken,client_id:config.clientId,resource:ORIGIN+'/mcp'});
      const v=refreshed.value;if(refreshed.status!==200||typeof v.access_token!=='string'||!v.access_token||typeof v.refresh_token!=='string'||!v.refresh_token)throw new KnowledgeProjectError('KNOWLEDGE_RECONNECT_REQUIRED',{permanent:true});
      const lock=JSON.parse(readFileSync(path));if(lock.token!==token||lock.expires<Date.now())throw new KnowledgeProjectError('KNOWLEDGE_REFRESH_UNCONFIRMED',{permanent:true});
      config={...config,accessToken:v.access_token,refreshToken:v.refresh_token};delete config.refreshPending;save(config);return config;
    }catch(error){throw error instanceof KnowledgeProjectError?error:new KnowledgeProjectError('KNOWLEDGE_RECONNECT_REQUIRED',{permanent:true});}
    finally{try{if(JSON.parse(readFileSync(path)).token===token)unlinkSync(path);}catch{}}
  }
  async function json(url,body,token){let r;try{r=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new KnowledgeProjectError('KNOWLEDGE_UNCONFIRMED');}
    let bytes=0,parts=[];for await(const p of r.body){if((bytes+=p.length)>524288)throw new KnowledgeProjectError('KNOWLEDGE_INVALID_RESPONSE');parts.push(p);}
    let v;try{v=JSON.parse(Buffer.concat(parts));}catch{throw new KnowledgeProjectError('KNOWLEDGE_INVALID_RESPONSE');}
    return {status:r.status,value:v};}
  async function call(name,input){let config=load();let r=await json(ORIGIN+'/api/knowledge/v1/operations/kb_'+name,input,config.accessToken);
    if(r.status===401&&config.refreshToken&&config.clientId){
      config=await refresh(config);
      r=await json(ORIGIN+'/api/knowledge/v1/operations/kb_'+name,input,config.accessToken);
    }
    if(r.status<200||r.status>=300)throw new KnowledgeProjectError([401,403].includes(r.status)?'KNOWLEDGE_RECONNECT_REQUIRED':'KNOWLEDGE_UNCONFIRMED',{permanent:[400,401,403,409].includes(r.status)});
    return r.value;
  }
  return {async ensure(job){
    if(!/^[0-9a-f-]{36}$/.test(job.id)||!job.name?.trim())throw new KnowledgeProjectError('KNOWLEDGE_INVALID_PROJECT',{permanent:true});
    const slug='kick-'+job.id;
    const result=await call('space_create',{name:job.name,slug,description:'Kick project '+job.id,requestId:job.id});
    const id=result.result?.id||result.receipt?.id||result.receipt?.spaceId;
    if(result.state!=='succeeded'||!id)throw new KnowledgeProjectError('KNOWLEDGE_OPERATION_UNCONFIRMED',{permanent:true});
    const value=await call('space_get',{spaceId:id});
    const space=value.data||value;
    if(space.id!==id||space.slug!==slug||space.name!==job.name)throw new KnowledgeProjectError('KNOWLEDGE_SPACE_MISMATCH',{permanent:true});
    return {spaceId:id,url:ORIGIN+'/s/'+encodeURIComponent(slug)};
  }};
}
