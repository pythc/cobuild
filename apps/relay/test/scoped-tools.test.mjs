import test from'node:test';import assert from'node:assert/strict';
import{createScopedTools,scopeHash}from'../harness/backend/scoped-tools.mjs';import{ToolSessions}from'../harness/tool-sessions.mjs';
function fixture(){
 const state={person:{id:'user-a',account:'student01',name:'User',role:'STUDENT',status:'ACTIVE'},calls:[]};
 const db={query:async(sql,args)=>{if(!sql.startsWith('SELECT id,account,name'))throw Error('Unexpected query');assert.equal(args[0],'school');return args[1]===scopeHash(state.person.id)?[{...state.person}]:[];}};
 const tools=createScopedTools({db,schoolId:'school',actor:{},diagnostics:{},statusProbe:{},knowledgeClient:{},createEvidence:deps=>async request=>({invoke:async(name,args)=>{
  const before=await deps.policy.get(request.group.id);assert.equal(before.fingerprint,request.group.fingerprint);
  if(name==='query_database')await deps.data.resolve('school',args.subject,[args.role]);state.calls.push({name,args});if(state.revoke)state.person.status='DISABLED';return {status:'found',rows:[]};
 }})});
 const context={scope:{principal:scopeHash('user-a'),app:'grading-internal'},conversationId:'one',history:[{role:'user',content:'上传失败'}]};return{state,tools,context};
}
test('backend tools bind account and role to the verified Relay principal; model cannot select another account or SQL',async()=>{
 const f=fixture(),session=await f.tools.open(f.context);await session.invoke('query_database',{resource:'uploads',start:null,end:null});assert.equal(f.state.calls[0].args.subject,'student01');assert.equal(f.state.calls[0].args.role,'STUDENT');
 await session.invoke('search_logs',{service:'server-api'});assert.equal(f.state.calls[1].args.subject,'student01');
 await assert.rejects(session.invoke('query_database',{resource:'accounts',subject:'someone-else'}),/参数无效/);
 await assert.rejects(session.invoke('query_database',{resource:'accounts',sql:'SELECT *'}),/参数无效/);
 await assert.rejects(session.invoke('reset_password',{}),/没有此项工具权限/);
});
test('other applications, unknown identities and revoked accounts cannot query; changes during a query discard its result',async()=>{
 const f=fixture();await assert.rejects(f.tools.open({...f.context,scope:{...f.context.scope,app:'makit'}}),/未绑定/);await assert.rejects(f.tools.open({...f.context,scope:{...f.context.scope,principal:scopeHash('someone-else')}}),/不可用于查询/);
 const session=await f.tools.open(f.context);f.state.revoke=true;await assert.rejects(session.invoke('service_status',{service:'all'}),/不可用于查询/);
});
test('tool sessions isolate scopes, stop after expiration/cancellation, and convert failed queries to a real handoff',async()=>{
 let now=1,received;const tools=new ToolSessions({key:'k'.repeat(32),now:()=>now,request:async(_url,o)=>{received=JSON.parse(o.body);return new Response(JSON.stringify({status:'unavailable'}),{status:409});}}),abort=new AbortController();
 const context={scope:{principal:scopeHash('user-a'),app:'grading-internal'},conversationId:'one',history:[]},session=tools.open(context,abort.signal);
 const value=await tools.invoke(session.token,'query_database',{resource:'accounts'});assert.equal(value.status,'unavailable');assert.deepEqual(received.context.scope,context.scope);
 const answer=await session.finish({answer:'假称已查明',handoff:false});assert.equal(answer.handoff,true);assert.doesNotMatch(answer.answer,/已查明/);assert.deepEqual(session.result(answer),answer);
 session.close();await assert.rejects(tools.invoke(session.token,'query_database',{}),/已失效/);
 const exp=tools.open(context,abort.signal);now=200000;await assert.rejects(tools.invoke(exp.token,'query_database',{}),/已失效/);
 const cancelled=tools.open(context,abort.signal);abort.abort();await assert.rejects(tools.invoke(cancelled.token,'service_status',{service:'all'}),/已失效/);
});
test('attempts to call write tools are denied before the backend sees any request',async()=>{
 let requests=0;const tools=new ToolSessions({key:'k',request:async()=>{requests++;}}),session=tools.open({history:[]},new AbortController().signal);
 await assert.rejects(tools.invoke(session.token,'reset_password',{account:'x'}),/没有工具权限/);assert.equal(requests,0);session.close();
});
