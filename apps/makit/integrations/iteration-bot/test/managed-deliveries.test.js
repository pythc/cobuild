import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedDeliveryConsumer} from '../src/managed-deliveries.js';
import {createNotificationGateway} from '../src/notification-gate.js';
const original={...process.env};
function setup(t){
  Object.assign(process.env,{WORKFLOW_DELIVERY_OWNER:'managed_bot',WORKFLOW_DELIVERY_API_URL:'https://example.invalid/openapi/workflow-deliveries',WORKFLOW_DELIVERY_WORKER_TOKEN:'s'.repeat(32)});
  t.after(()=>{for(const k of ['WORKFLOW_DELIVERY_OWNER','WORKFLOW_DELIVERY_API_URL','WORKFLOW_DELIVERY_WORKER_TOKEN'])if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];});
}
const config={identities:{messages:'bot'},notifications:{mode:'test_only',allowedChatIds:['oc_test']}};
const item={id:'11111111-1111-4111-8111-111111111111',idempotencyKey:'11111111-1111-4111-8111-111111111111',leaseToken:'lease',channel:'feishu_group',targetId:'oc_test',payload:{type:'interactive',receiveIdType:'chat_id',content:{schema:'2.0'}}};
test('managed workflow source only enqueues, never sends as the user or directly',async t=>{
  setup(t);const queued=[],calls=[];const gateway=createNotificationGateway({config,cli:{json:async x=>calls.push(x)},enqueueDelivery:async e=>{queued.push(e);return{queued:true};}});
  await gateway.sendCard({chatId:'oc_test'},{schema:'2.0'},'event',{eventId:'event',requirementId:'recQaOnly',purpose:'workflow'});
  assert.equal(queued.length,1);assert.equal(calls.length,0);assert.equal(queued[0].localAllowed,true);
});
test('real receipt acknowledgement and identity preserved with no external I/O',async t=>{
  setup(t);const bodies=[],sends=[];
  const consumer=createManagedDeliveryConsumer({config,sendCard:async(...args)=>{sends.push(args);return{response:{data:{message_id:'om_receipt'}}};},sendPost:async()=>{},log:()=>{},fetchImpl:async(url,o)=>{
    bodies.push(JSON.parse(o.body));return Response.json(url.endsWith('/claim')?{items:[item]}:{accepted:true});}});
  assert.equal((await consumer.runOnce()).processed,1);assert.equal(bodies[1].outcome,'sent');assert.equal(bodies[1].messageId,'om_receipt');assert.equal(sends[0][2],item.id);assert.equal(sends[0][3].source,'managed_deliveries');
});
test('transport exception remains unknown; failed acknowledgement does not resend',async t=>{
  setup(t);let sends=0;const bodies=[];
  const consumer=createManagedDeliveryConsumer({config,sendCard:async()=>{sends++;throw new Error('transport lost');},sendPost:async()=>{},log:()=>{},fetchImpl:async(url,o)=>{bodies.push(JSON.parse(o.body));return Response.json(url.endsWith('/claim')?{items:[item]}:{accepted:false});}});
  await assert.rejects(consumer.runOnce());assert.equal(sends,1);assert.equal(bodies[1].outcome,'unknown');
});
test('legacy mode never claims and a user-identity consumer is refused',async t=>{
  setup(t);let calls=0;const consumer=createManagedDeliveryConsumer({config:{identities:{messages:'user'}},fetchImpl:async()=>{calls++;},sendCard:()=>{},sendPost:()=>{},log:()=>{}});
  await assert.rejects(consumer.runOnce());assert.equal(calls,0);process.env.WORKFLOW_DELIVERY_OWNER='legacy';assert.deepEqual(await consumer.runOnce(),{processed:0});
});
