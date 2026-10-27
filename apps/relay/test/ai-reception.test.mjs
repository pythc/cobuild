import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RelayStore} from '../server/store.mjs';
import {AiReception,aiContext} from '../server/ai-reception.mjs';
const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,request){
 const dir=mkdtempSync(join(tmpdir(),'relay-ai-')),store=new RelayStore(dir),messages=[],posts=[];
 const row={id:'cw_1_1',principal:'customer',app:'makit',remote_id:1,source_id:'s',created_at:new Date().toISOString()};
 const chat={account:p=>p,config:()=>({apps:{makit:{name:'Makit',inboxId:2}}}),messages:async()=>structuredClone(messages),request:async(path,options)=>{
  if(options?.method==='POST'){posts.push(options.body);const m={id:messages.length+100,message_type:1,private:false,content:options.body.content,content_attributes:options.body.content_attributes,created_at:Date.now()/1000};messages.push(m);return {id:m.id};}
  return {inbox_id:2,status:'open'};
 }};
 const ai=new AiReception({store,chat,config:{enabled:true,endpoint:'http://127.0.0.1:18504/reply',key:'x'.repeat(32)},request:request||(async()=>new Response(JSON.stringify({answer:'收到，请提供报错信息。',handoff:false})))});
 ai.wake=()=>{};
 await store.register(row,'用户');ai.register(row,{name:'用户',account:'account',app:'makit'});
 t.after(async()=>{await ai.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 const incoming=(id,content='用户咨询')=>messages.push({id,message_type:0,private:false,content,created_at:Date.now()/1000});
 const persisted=()=>({...row,...store.db.prepare('SELECT * FROM ai_reception WHERE conversation_id=?').get(row.id),id:row.id});
 return {dir,store,ai,chat,messages,posts,row,incoming,persisted};
}
test('old conversations stay human; new inquiries receive one AI reply with isolated public context',async t=>{
 let received;const f=await fixture(t,async(_url,opts)=>{received=JSON.parse(opts.body);return new Response(JSON.stringify({answer:'你好',handoff:false}));});
 f.incoming(1);f.messages.push({id:2,message_type:1,private:true,content:'internal secret',created_at:Date.now()/1000});
 await f.ai.run(f.persisted(),new AbortController().signal);await f.ai.run(f.persisted(),new AbortController().signal);
 assert.equal(f.posts.length,1);assert.equal(received.user.name,'用户');assert.equal(received.user.account,'account');assert.equal(received.history.length,1);assert.equal(f.ai.status(f.row.id).mode,'ai');
 const old={...f.row,id:'old',remote_id:2};await f.store.register(old,'Old');
 const other=new AiReception({store:f.store,chat:f.chat,config:{enabled:false}});assert.equal(other.status('old').mode,'human');await other.stop();
});
test('takeover during generation fences AI posting; restoring AI answers only pending incoming messages',async t=>{
 let release;const ready=new Promise(resolve=>release=resolve);
 const f=await fixture(t,async()=>{await ready;return new Response(JSON.stringify({answer:'late response',handoff:false}));});
 f.incoming(1);const running=f.ai.run(f.persisted(),new AbortController().signal);await pause();await f.ai.withGate(f.row.id,()=>f.ai.human(f.row.id));release();await running;
 assert.equal(f.posts.length,0);assert.equal(f.ai.status(f.row.id).mode,'human');
 await f.ai.resume(f.row);await f.ai.run(f.persisted(),new AbortController().signal);assert.equal(f.posts.length,1);
});
test('a new incoming message while AI is generating cancels the stale answer, then coalesces context',async t=>{
 let release;const ready=new Promise(resolve=>release=resolve);const f=await fixture(t,async()=>{await ready;return new Response(JSON.stringify({answer:'combined answer',handoff:false}));});
 f.incoming(1);const running=f.ai.run(f.persisted(),new AbortController().signal);await pause();f.incoming(2,'补充问题');release();await running;
 assert.equal(f.posts.length,0);await f.ai.run(f.persisted(),new AbortController().signal);assert.equal(f.posts.length,1);assert.equal(f.persisted().cursor,2);
});
test('an uncertain AI send is reconciled across restart without duplicate posting, even after human takeover',async t=>{
 const f=await fixture(t);f.incoming(1);await f.ai.run(f.persisted(),new AbortController().signal);
 f.store.db.prepare("UPDATE ai_reception SET state='sending',cursor=0 WHERE conversation_id=?").run(f.row.id);
 const restarted=new AiReception({store:f.store,chat:f.chat,config:{enabled:false}});restarted.human(f.row.id);
 await restarted.run(f.persisted(),new AbortController().signal);assert.equal(f.posts.length,1);assert.equal(f.persisted().state,'done');assert.equal(f.persisted().mode,'human');await restarted.stop();
});
test('an unconfirmed AI send is never blindly posted again',async t=>{
 const f=await fixture(t);f.incoming(1);f.store.db.prepare("UPDATE ai_reception SET state='unknown',trigger_id=1,marker='missing' WHERE conversation_id=?").run(f.row.id);
 await f.ai.run(f.persisted(),new AbortController().signal);assert.equal(f.posts.length,0);assert.equal(f.persisted().state,'unknown');
});
test('explicit AI handoff leaves the conversation available to humans',async t=>{
 const f=await fixture(t,async()=>new Response(JSON.stringify({answer:'需要人工进一步核对。',handoff:true})));f.incoming(1);
 await f.ai.run(f.persisted(),new AbortController().signal);assert.equal(f.posts.length,1);assert.equal(f.ai.status(f.row.id).mode,'human');
});
test('AI context never includes private notes, service tokens, attachment URLs, or other conversation history',()=>{
 const value=aiContext({id:'a',app:'makit'},{name:'User',account:'user',token:'secret'},[{message_type:0,content:'hello',attachments:[{file_name:'screenshot.png',file_type:'image',data_url:'secret'}]},{message_type:1,private:true,content:'private'}],'Makit');
 assert.equal(value.history.length,1);assert.equal(JSON.stringify(value).includes('secret'),false);assert.equal(JSON.stringify(value).includes('private'),false);
});
test('AI handoff does not consume the human reminder cycle',async t=>{
 const f=await fixture(t,async()=>new Response(JSON.stringify({answer:'需要人工核对。',handoff:true})));f.incoming(1);
 f.store.attention.ingest(f.row.id,f.messages);await f.ai.run(f.persisted(),new AbortController().signal);f.store.attention.ingest(f.row.id,f.messages);
 assert.equal(f.store.attention.summary(f.row.id).pending?.id,1);
});
test('a failed reconciliation and a racing takeover never erase an uncertain send marker',async t=>{
 const f=await fixture(t);f.incoming(1);
 f.store.db.prepare("UPDATE ai_reception SET state='unknown',marker='persisted',trigger_id=1 WHERE conversation_id=?").run(f.row.id);
 f.ai.failed(f.persisted(),Object.assign(Error('GET outage'),{rejected:true}));assert.equal(f.persisted().state,'unknown');assert.equal(f.persisted().marker,'persisted');
 await assert.rejects(f.ai.resume(f.row),/待核对/);
 f.store.db.prepare("UPDATE ai_reception SET state='sending' WHERE conversation_id=?").run(f.row.id);
 const old=f.persisted();f.ai.human(f.row.id);f.ai.failed(old,Error('POST timeout'));
 assert.equal(f.persisted().state,'unknown');assert.equal(f.persisted().mode,'human');
});
test('a confirmed rejected AI POST can return to human handling without an unknown receipt',async t=>{
 const f=await fixture(t);f.store.db.prepare("UPDATE ai_reception SET state='sending' WHERE conversation_id=?").run(f.row.id);
 f.ai.failed(f.persisted(),{rejected:true});assert.equal(f.persisted().state,'error');assert.equal(f.persisted().mode,'human');
});
test('restored legacy conversations retain the verified local customer name when AI resumes',async t=>{
 const f=await fixture(t);f.store.db.prepare("UPDATE ai_reception SET profile_json='{}',mode='human' WHERE conversation_id=?").run(f.row.id);
 const restored=new AiReception({store:f.store,chat:f.chat,config:{enabled:false}});const profile=JSON.parse(f.persisted().profile_json);assert.equal(profile.name,'用户');
 assert.equal(aiContext(f.row,profile,[],"Makit").user.name,'用户');await restored.stop();
});
test('long Unicode conversation context remains within the CLI argument byte limit and marks truncation',()=>{
 const value=aiContext({id:'a',principal:'a'.repeat(64),app:'grading-internal'},{name:'User'},Array.from({length:40},()=>({message_type:0,content:'中'.repeat(4000)})),'批改系统');
 assert.equal(value.historyTruncated,true);assert.ok(Buffer.byteLength(JSON.stringify(value))<65000);assert.equal(value.scope.principal,'a'.repeat(64));
});
test('intentional service shutdown preserves AI mode and resumes generation; uncertain sends remain fenced',async t=>{
 const f=await fixture(t);f.store.db.prepare("UPDATE ai_reception SET state='generating',trigger_id=1 WHERE conversation_id=?").run(f.row.id);f.ai.stopped=true;f.ai.failed(f.persisted(),Error('shutdown'));
 assert.equal(f.persisted().mode,'ai');assert.equal(f.persisted().state,'idle');
 f.store.db.prepare("UPDATE ai_reception SET state='sending' WHERE conversation_id=?").run(f.row.id);f.ai.failed(f.persisted(),Error('shutdown'));assert.equal(f.persisted().state,'unknown');
});
