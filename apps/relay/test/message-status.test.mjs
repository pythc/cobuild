import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RelayStore} from '../server/store.mjs';
import {messageStatus,mapLimit} from '../server/message-status.mjs';
import {mergeOutbox,pruneOutbox} from '../src/outbox.js';
test('delivery states require real visible read receipts; private notes and other conversations cannot mark read',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-status-')),store=new RelayStore(dir);try{
 const row={id:'one'},m={id:9,message_type:1,private:false,created_at:Date.now()/1000};store.saveReplies('one',9,[9]);
 assert.equal(messageStatus(store,row,m,'operator'),'unread');store.readReplies('one',9);assert.equal(messageStatus(store,row,m,'operator'),'read');
 assert.equal(messageStatus(store,{id:'two'},m,'operator'),'unread');assert.equal(messageStatus(store,row,{...m,private:true},'operator'),undefined);
 assert.equal(messageStatus(store,row,{...m,id:1,created_at:1},'operator'),'read');assert.equal(messageStatus(store,{id:'two'},{...m,created_at:1},'operator'),'sent');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('optimistic messages show immediately, update list previews/order, reconcile by stable identity and preserve failed sends',()=>{
 const base=[{id:'old',time:'2026-10-17T01:00:00Z',messages:[]},{id:'new',time:'2026-10-17T02:00:00Z',messages:[]}];
 const pending={id:'local-a',clientId:'a',conversationId:'old',content:'new reply',side:'operator',time:'2026-10-17T03:00:00Z',delivery:'sending'};
 const merged=mergeOutbox(base,[pending]);assert.equal(merged[0].id,'old');assert.equal(merged[0].preview,'new reply');assert.equal(merged[0].messages[0].delivery,'sending');
 const refreshed=[{...base[0],messages:[{...pending,id:'42'}]},base[1]];assert.equal(mergeOutbox(refreshed,[pending])[0].messages.length,1);assert.equal(pruneOutbox([pending],refreshed).length,0);
 assert.equal(pruneOutbox([{...pending,delivery:'failed'}],base).length,1);
});
test('inbox catch-up is bounded and concurrent while preserving ordering',async()=>{
 let active=0,max=0;const result=await mapLimit([1,2,3,4,5,6,7],3,async v=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,3));active--;return v*2;});
 assert.equal(max,3);assert.deepEqual(result,[2,4,6,8,10,12,14]);
});
