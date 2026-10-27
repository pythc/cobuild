import {createHash} from 'node:crypto';
const shape=(value,keys)=>{if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!keys.includes(k)))throw Error('查询参数无效');};
export const scopeHash = id=>createHash('sha256').update('widget:grading:'+id).digest('hex');
const signature=p=>createHash('sha256').update(JSON.stringify([p.id,p.account,p.role,p.status])).digest('hex');
export function createScopedTools({db,schoolId,createEvidence,diagnostics,actor,statusProbe,knowledgeClient,now=Date.now}) {
 async function person(scope){
  if(!scope||scope.app!=='grading-internal'||!/^[a-f0-9]{64}$/.test(scope.principal||''))throw Error('当前来源未绑定批改系统账号');
  const rows=await db.query(`SELECT id,account,name,role,status FROM users WHERE school_id=$1 AND public_identity_id IS NULL
   AND role IN ('STUDENT','TEACHER') AND encode(sha256(convert_to('widget:grading:'||id::text,'UTF8')),'hex')=$2 LIMIT 2`,[schoolId,scope.principal]);
  if(rows.length!==1||rows[0].status!=='ACTIVE')throw Error('当前登录账号不可用于查询');return rows[0];
 }
 async function open(context){
  const bound=await person(context.scope),fingerprint=signature(bound);
  const group={id:'relay:'+context.conversationId,schoolId,fingerprint,diagnostics:true,teacherServices:{diagnostics:true}};
  const policy={get:async()=>{const current=await person(context.scope);return signature(current)===fingerprint?group:null;}};
  async function authorize(){if(!(await policy.get()))throw Error('当前账号权限已变化');}
  const publicKnowledge=async()=>({
   validate:authorize,
   async searchKnowledge(query){
    await authorize();if(typeof query!=='string'||!query.trim()||query.length>400)throw Error('检索词无效');
    const documents=()=>db.query(`SELECT id,title,revision,published_version FROM assistant_knowledge_documents WHERE NOT deleted AND published_version IS NOT NULL
      AND (school_id IS NULL OR school_id=$1) AND ((visibility='PUBLIC' AND audience_role IS NULL) OR (visibility='USERS' AND (audience_role IS NULL OR audience_role::text=$2))) ORDER BY id`,[schoolId,bound.role]);
    const docs=await documents();if(!docs.length)return {items:[]};
    const result=await knowledgeClient.request('/search',{query,mode:'hybrid',top_k:6,libraries:docs.map(d=>d.id)});
    if(JSON.stringify(await documents())!==JSON.stringify(docs))throw Error('资料已更新');await authorize();
    if(!Array.isArray(result.items))throw Error('资料查询未完成');
    return {items:result.items.slice(0,6).flatMap(item=>{const doc=docs.find(d=>d.id===item.library_id&&d.id===item.document_id&&d.published_version===item.version_id);return doc&&typeof item.text==='string'?[{title:doc.title,text:item.text.slice(0,6000),page:item.page}]:[];})};
   }
  });
  const evidence=await createEvidence({db,diagnostics,actor,statusProbe,policy,openEvidence:publicKnowledge,
    data:{resolve:async(school,subject,roles)=>{await authorize();if(school!==schoolId||subject!==bound.account||!roles.includes(bound.role))throw Error('仅能查询当前登录账号');return {status:'found',person:bound};}},now})({
    group,question:'当前已验证账号：'+bound.account+'。'+(context.history.filter(m=>m.role==='user').at(-1)?.content||''),history:[],signal:context.signal,
  });
  return {async invoke(name,args){
    const fields={query_database:['resource','start','end','assignment','purpose'],search_logs:['service','severity','text','start','end','trace'],service_status:['service'],search_knowledge:['query']};
    if(!Object.hasOwn(fields,name))throw Error('没有此项工具权限');shape(args,fields[name]);
    // Identity and school come from Relay's verified principal. The model cannot
    // supply another subject, an arbitrary SQL statement, or a different tenant.
    const input=['query_database','search_logs'].includes(name)?{...args,subject:bound.account,role:bound.role}:args;
    await authorize();const value=await evidence.invoke(name,input);await authorize();return value;
  }};
 }
 return {open};
}
