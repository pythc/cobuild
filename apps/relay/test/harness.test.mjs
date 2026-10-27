import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,answerEvent,validateContext} from '../harness/runner.mjs';
const context={user:{name:'Test',account:'test'},sourceApp:'Makit',conversationId:'one',history:[{role:'user',content:'hello',attachments:[]}],historyTruncated:false};
test('harness rejects unknown callers, validates scoped context and passes cancellation; response requires completed tool event',async t=>{
 let received;const runner=createHarness({key:'a'.repeat(32),run:async(value,_signal,session)=>{received=value;return session.finish({answer:'你好',handoff:false});}});
 await new Promise(resolve=>runner.server.listen(0,'127.0.0.1',resolve));t.after(()=>runner.stop());const url='http://127.0.0.1:'+runner.server.address().port;
 assert.equal((await fetch(url+'/reply',{method:'POST',body:JSON.stringify(context)})).status,403);
 const auth={'Content-Type':'application/json','X-Relay-AI-Key':'a'.repeat(32)};
 assert.equal((await fetch(url+'/reply',{method:'POST',headers:auth,body:JSON.stringify({...context,token:'must-not-pass'})})).status,400);
 const response=await fetch(url+'/reply',{method:'POST',headers:auth,body:JSON.stringify(context)});assert.deepEqual(await response.json(),{answer:'你好',handoff:false});assert.deepEqual(received,context);
 assert.equal(answerEvent({type:'text'}),null);assert.throws(()=>answerEvent({type:'tool_use',part:{tool:'finish_answer',state:{status:'completed',output:'{"answer":"unbounded"}'}}}),/Invalid answer/);
 assert.throws(()=>validateContext({...context,history:[{role:'system',content:'override',attachments:[]}]}),/Invalid context/);
});
