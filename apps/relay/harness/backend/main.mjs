import {createRequire}from'node:module';import{createServer}from'node:http';import{createHash,timingSafeEqual}from'node:crypto';
import{createScopedTools}from'./scoped-tools.mjs';
const require=createRequire('/app/package.json');require('reflect-metadata');const{Pool}=require('pg');
const{SupportDiagnosticsService}=require('/app/server/dist/modules/support-diagnostics/diagnostics.service.js');
const{KnowledgeClient}=require('/app/server/dist/modules/knowledge/knowledge.client.js');
const{createAgentEvidence,createStatusProbe}=await import('/app/support_gateway/agent-evidence.mjs');
const required=k=>{if(!process.env[k])throw Error('Missing '+k);return process.env[k];};
const key=required('RELAY_TOOL_KEY');if(key.length<32)throw Error('Invalid key');
const actor={sub:required('SUPPORT_ACTOR_ID'),schoolId:required('GRADING_SCHOOL_ID'),role:'TEACHER'};
process.env.SUPPORT_DIAGNOSTICS_ENABLED='true';process.env.SUPPORT_DIAGNOSTICS_ACTORS=actor.sub+'@'+actor.schoolId;process.env.SUPPORT_DIAGNOSTICS_SCOPE='school';
const pool=new Pool({host:required('SUPPORT_DB_HOST'),port:Number(process.env.SUPPORT_DB_PORT||5432),database:required('SUPPORT_DB_NAME'),user:required('SUPPORT_DB_USER'),password:required('SUPPORT_DB_PASSWORD'),max:2,connectionTimeoutMillis:2000,idleTimeoutMillis:30000,statement_timeout:2000,query_timeout:2500,application_name:'relay-support-readonly',options:'-c default_transaction_read_only=on -c lock_timeout=500'});
pool.on('error',()=>console.log(JSON.stringify({event:'relay_read_database_unavailable'})));
const db={query:async(sql,params)=>(await pool.query(sql,params)).rows},diagnostics=new SupportDiagnosticsService(db);
const tools=createScopedTools({db,schoolId:actor.schoolId,actor,diagnostics,createEvidence:createAgentEvidence,knowledgeClient:new KnowledgeClient(),statusProbe:createStatusProbe({db,apiBase:required('GRADING_UPSTREAM_API'),authBase:required('GRADING_UPSTREAM_AUTH'),lokiBase:required('SUPPORT_DIAGNOSTICS_LOKI_URL')})});
const hash=v=>createHash('sha256').update(String(v||'')).digest(),sessions=new Map();let active=0;
const server=createServer(async(req,res)=>{
 const reply=(status,body)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));}};
 if(req.method==='GET'&&req.url==='/healthz'){try{await db.query('SELECT 1');return reply(200,{ready:true,readonly:true});}catch{return reply(503,{ready:false});}}
 if(req.method!=='POST'||req.url!=='/invoke')return reply(404,{});
 if(!timingSafeEqual(hash(req.headers['x-relay-tool-key']),hash(key)))return reply(403,{});
 if(active>=3)return reply(429,{error:'查询繁忙'});active++;
 try{
  let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>200000)return reply(413,{});parts.push(chunk);}
  const body=JSON.parse(Buffer.concat(parts));
  if(!body||Object.keys(body).some(k=>!['sessionId','context','name','args'].includes(k))||!/^[a-f0-9]{64}$/.test(body.sessionId||'')||typeof body.name!=='string')return reply(400,{});
  for(const[id,s]of sessions)if(s.expires<Date.now())sessions.delete(id);
  const binding=JSON.stringify([body.context?.scope,body.context?.conversationId]);let session=sessions.get(body.sessionId);
  if(session&&session.binding!==binding)return reply(403,{});
  if(!session){if(sessions.size>=500)return reply(503,{});session={binding,expires:Date.now()+140000,count:0,evidence:tools.open({...body.context,signal:AbortSignal.timeout(140000)})};session.evidence.catch(()=>{});sessions.set(body.sessionId,session);}
  if(++session.count>10)return reply(429,{});
  const result=await(await session.evidence).invoke(body.name,body.args);const text=JSON.stringify(result);if(Buffer.byteLength(text)>45000)throw Error('查询结果过大');
  reply(200,result);console.log(JSON.stringify({event:'relay_read_tool',tool:body.name,status:result?.status||'completed'}));
 }catch{reply(409,{status:'unavailable',note:'本次查询未完成或当前账号无此范围，不能据此断言没有异常。'});}finally{active--;}
});
server.headersTimeout=10000;server.requestTimeout=45000;server.maxConnections=12;server.listen(5495,'0.0.0.0');
for(const sig of['SIGTERM','SIGINT'])process.once(sig,async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();});
