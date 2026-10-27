// Read only the existing application's visible enterprise directory. Profiles
// here are project candidates, never login sessions or administrator grants.
const ORIGIN='https://open.feishu.cn';
const MAX_MEMBERS=1000,MAX_DEPARTMENTS=100;
export class DirectoryError extends Error {constructor(){super('企业成员暂时无法同步');}}
export function createWorkspaceDirectory({config,fetchImpl=fetch,now=Date.now}){
  let token=null,tokenExpires=0,cached=null,expires=0,pending=null,retryAfter=0;
  async function request(path,{body,signal}={}){
    try{
      const response=await fetchImpl(ORIGIN+'/open-apis/'+path,{method:body?'POST':'GET',redirect:'error',signal,
        headers:body?{'Content-Type':'application/json'}:{Authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})});
      if(!response.ok)throw new DirectoryError();
      const parts=[];let size=0;const reader=response.body.getReader();
      try{for(;;){const {done,value}=await reader.read();if(done)break;if((size+=value.byteLength)>512*1024){await reader.cancel();throw new DirectoryError();}parts.push(value);}}finally{reader.releaseLock();}
      const value=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(value?.code!==0)throw new DirectoryError();return value;
    }catch{throw new DirectoryError();}
  }
  async function pages(path,params,signal,limit){
    const result=[],seen=new Set();let cursor='';
    for(let page=0;page<25;page++){
      const query=new URLSearchParams({...params,page_size:'50',...(cursor?{page_token:cursor}:{})});
      const {data}=await request(path+'?'+query,{signal});
      if(!data||!Array.isArray(data.items)||typeof data.has_more!=='boolean')throw new DirectoryError();
      result.push(...data.items);if(result.length>limit)throw new DirectoryError();
      if(!data.has_more)return result;
      cursor=data.page_token;if(typeof cursor!=='string'||!cursor||cursor.length>2048||seen.has(cursor))throw new DirectoryError();seen.add(cursor);
    }
    throw new DirectoryError();
  }
  async function refresh(){
    const signal=AbortSignal.timeout(10000);
    if(!token||tokenExpires<=now()){
      const value=await request('auth/v3/tenant_access_token/internal',{body:{app_id:config.appId,app_secret:config.appSecret},signal});
      if(typeof value.tenant_access_token!=='string'||!value.tenant_access_token||value.tenant_access_token.length>2048||!Number.isInteger(value.expire)||value.expire<120||value.expire>86400)throw new DirectoryError();
      token=value.tenant_access_token;tokenExpires=now()+(value.expire-60)*1000;
    }
    const departments=await pages('contact/v3/departments/0/children',{department_id_type:'open_department_id',fetch_child:'true'},signal,MAX_DEPARTMENTS);
    const ids=new Set(['0']);
    for(const row of departments){const id=row.open_department_id;if(typeof id!=='string'||!/^od-[a-zA-Z0-9_-]{1,100}$/.test(id))throw new DirectoryError();ids.add(id);}
    const members=new Map(),direct=new Map(),inactive=new Set();let rows=0,complete=true;
    for(const id of ids){
      direct.set(id,new Set());
      const users=await pages('contact/v3/users/find_by_department',{department_id:id,department_id_type:'open_department_id',user_id_type:'union_id'},signal,MAX_MEMBERS);
      if((rows+=users.length)>5000)throw new DirectoryError();
      for(const user of users){
        if(!/^on_[a-zA-Z0-9_-]{10,100}$/.test(user.union_id||''))complete=false;
        if(!user.status||['is_resigned','is_exited','is_frozen','is_activated'].some(k=>typeof user.status[k]!=='boolean'))complete=false;
        if(user.status?.is_unjoin||user.status?.is_resigned||user.status?.is_exited||user.status?.is_frozen||user.status?.is_activated===false||user.is_frozen){if(typeof user.union_id==='string')inactive.add(config.tenantKey+':'+user.union_id);continue;}
        if(!/^on_[a-zA-Z0-9_-]{10,100}$/.test(user.union_id||'')||typeof user.name!=='string'||!user.name.trim()||user.name.length>80||/[\x00-\x1f\x7f]/.test(user.name))throw new DirectoryError();
        const subject=config.tenantKey+':'+user.union_id;direct.get(id).add(subject);
        // Email fields may be omitted by the provider's field permissions.
        // Do not invent an address or fall back to a personal contact email.
        const email=typeof user.enterprise_email==='string'&&/^[-a-zA-Z0-9._+]+@110-lab\.cn$/i.test(user.enterprise_email)?user.enterprise_email.toLowerCase():'';
        let avatarUrl='';try{const a=new URL(user.avatar?.avatar_240);if(a.protocol==='https:'&&a.hostname.endsWith('.feishucdn.com')&&!a.username&&!a.password&&!a.port&&a.href.length<2048)avatarUrl=a.href;}catch{}
        members.set(subject,{subject,employeeId:typeof user.user_id==='string'?user.user_id:'',name:user.name.trim(),email,...(avatarUrl?{avatarUrl}:{})});if(members.size>MAX_MEMBERS)throw new DirectoryError();
      }
    }
    const groups=new Map();
    for(const row of departments){
      if(typeof row.name!=='string'||!row.name.trim()||row.name.length>1000||typeof row.parent_department_id!=='string'||row.status?.is_deleted||groups.has(row.open_department_id)){complete=false;continue;}
      groups.set(row.open_department_id,{id:row.open_department_id,parentId:row.parent_department_id,name:row.name.trim(),path:'',subjects:new Set(direct.get(row.open_department_id))});
    }
    function visit(id,chain=new Set()){
      const g=groups.get(id);if(!g||chain.has(id)||chain.size>100)throw new DirectoryError();if(g.path)return g.path;chain.add(id);
      g.path=g.parentId==='0'?g.name:visit(g.parentId,chain)+' / '+g.name;chain.delete(id);return g.path;
    }
    if(complete){for(const g of groups.values())visit(g.id);for(const g of groups.values()){let id=g.parentId;while(id!=='0'){for(const subject of direct.get(g.id)||[])groups.get(id).subjects.add(subject);id=groups.get(id).parentId;}}}
    const active=[...members.values()].filter(m=>!inactive.has(m.subject));
    return {members:[...members.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')),activeMembers:active,departments:[...groups.values()].map(g=>({...g,subjects:[...g.subjects].filter(s=>!inactive.has(s))})),syncedAt:now(),complete};
  }
  async function load({fresh=false}={}){
    if(!fresh&&cached&&expires>now())return cached;
    if(pending)return pending;
    if(retryAfter>now())throw new DirectoryError();
    pending=refresh().then(value=>{cached=value;expires=now()+60000;retryAfter=0;return value;})
      .catch(()=>{token=null;tokenExpires=0;cached=null;expires=0;retryAfter=now()+30000;throw new DirectoryError();})
      .finally(()=>{pending=null;});
    return pending;
  }
  return {
    async list(options){return(await load(options)).members.map(m=>({...m}));},
    async snapshot(options){const v=await load(options);if(!v.complete)throw new DirectoryError();return structuredClone({members:v.activeMembers,departments:v.departments,syncedAt:v.syncedAt});}
  };
}
