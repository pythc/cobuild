import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RelayStore} from '../server/store.mjs';
import {UnreadReplies} from '../server/unread.mjs';

test('public replies only, pagination, exact monotonic read cursors, isolation and persistence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-unread-'));let store=new RelayStore(dir);
 try {
  const epoch=store.unreadEpoch(), make=(id,extra={})=>({id,message_type:1,private:false,created_at:epoch/1000+1,content:'reply',...extra});
  const rows=[make(1,{created_at:epoch/1000-1}),make(2,{message_type:0}),make(3,{private:true}),make(4,{message_type:2}),make(5,{status:'failed'}),make(6,{content_attributes:{deleted:true}}),make(7,{content:''}),make(8,{content:'',attachments:[{}]}),make(9)];
  const chat={account:p=>p,request:async()=>({payload:rows})}, unread=new UnreadReplies(store,chat);
  await unread.sync({id:'a',remote_id:1});assert.deepEqual(store.unreadReplies('a'),['8','9']);
  assert.throws(()=>store.readReplies('a',999),/尚未同步/);assert.throws(()=>store.readReplies('a',3),/尚未同步/);assert.throws(()=>store.readReplies('b',8),/尚未同步/);
  store.readReplies('a',8);unread.ingest({id:'a'},[make(10)]);assert.deepEqual(store.unreadReplies('a'),['9','10'],'a later reply remains unread when acknowledging an older visible reply');
  store.readReplies('a',9);store.readReplies('a',8);assert.deepEqual(store.unreadReplies('a'),['10'],'a stale tab cannot rewind the cursor');
  store.close();store=new RelayStore(dir);assert.equal(store.unreadEpoch(),epoch);assert.deepEqual(store.unreadReplies('a'),['10']);
  const many=Array.from({length:65},(_,i)=>make(100+i));let calls=0;
  const paged=new UnreadReplies(store,{account:p=>p,request:async path=>{calls++;const before=Number(new URL('http://x'+path).searchParams.get('before'))||Infinity;return {payload:many.filter(m=>m.id<before).slice(-20)};}});
  await Promise.all([paged.sync({id:'b',remote_id:2}),paged.sync({id:'b',remote_id:2})]);assert.equal(calls,4,'concurrent tabs share one catch-up');assert.equal(store.unreadReplies('b').length,65);
  const failed=new UnreadReplies(store,{account:p=>p,request:async()=>{throw Error('offline');}});await assert.rejects(failed.sync({id:'b',remote_id:2}),/offline/);assert.equal(store.unreadReplies('b').length,65);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
