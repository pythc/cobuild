import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {RelayStore} from '../server/store.mjs';

test('context extraction for ticket creation uses the operator identity with real SQLite unread storage',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'relay-context-'));
 const file=join(directory,'service.mjs');
 await build({stdin:{contents:"export {RelayChatwootService} from './server/modules/relay/relay-chatwoot.service.ts'",resolveDir:process.cwd()},bundle:true,platform:'node',target:'node24',format:'esm',outfile:file,external:['node:*'],banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});
 const {RelayChatwootService}=await import(pathToFileURL(file));
 const store=new RelayStore(join(directory,'data'));
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const saved={origin:process.env.RELAY_PUBLIC_ORIGIN,base:process.env.RELAY_PUBLIC_BASE_URL};
 process.env.RELAY_PUBLIC_ORIGIN='https://relay.test';process.env.RELAY_PUBLIC_BASE_URL='https://relay.test/relay';
 t.after(()=>{for(const [key,value]of Object.entries({RELAY_PUBLIC_ORIGIN:saved.origin,RELAY_PUBLIC_BASE_URL:saved.base}))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 const row={id:'cw_1_17',principal:'customer',app:'makit',remote_id:17,source_id:'source',created_at:new Date().toISOString()};
 await store.register(row,'Customer');
 const incoming={id:73,message_type:0,private:false,content:'Please help',created_at:Date.now()/1000};
 store.attention.ingest(row.id,[incoming]);
 const chat={config:()=>({apps:{makit:{name:'Makit',inboxId:2}},operators:{operator:1}}),account:p=>p,
  request:async()=>({inbox_id:2,status:'open',meta:{sender:{name:'Customer'}}}),messages:async()=>[incoming]};
 const service=new RelayChatwootService(chat,store,{},store,{}, {},{allowed:async()=>true},store);
 const context=await service.context(row.id,{employeeId:'operator',name:'Operator'});
 assert.equal(context.customerName,'Customer');
 assert.equal(context.messages[0].content,'Please help');
 assert.equal(store.attention.unread(row.id,'operator')[0],'73');
});

test('a failed conversation does not blank the whole inbox or masquerade as an empty complete history',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'relay-isolation-')),file=join(directory,'service.mjs');
 await build({stdin:{contents:"export {RelayChatwootService} from './server/modules/relay/relay-chatwoot.service.ts'",resolveDir:process.cwd()},bundle:true,platform:'node',target:'node24',format:'esm',outfile:file,external:['node:*'],banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});
 const {RelayChatwootService}=await import(pathToFileURL(file));const store=new RelayStore(join(directory,'data'));
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 for(const n of [1,2]){await store.register({id:'cw_'+n,principal:'customer',app:'makit',remote_id:n,source_id:'s'+n,created_at:new Date().toISOString()},'Customer');await store.activate('cw_'+n,String(n),new Date().toISOString());}
 const chat={config:()=>({apps:{makit:{inboxId:2}}}),account:p=>p,request:async()=>({inbox_id:2,status:'open'}),messages:async id=>{if(id===1)throw Error('upstream unavailable');return[{id:19,message_type:0,private:false,created_at:Date.now()/1000,content:'original question'},{id:20,message_type:1,private:false,created_at:Date.now()/1000,content:'latest visible'},{id:21,message_type:1,private:true,created_at:Date.now()/1000,content:'private note'}];}};
 const service=new RelayChatwootService(chat,store,{},store,{}, {},{allowed:async()=>true},store);
 const state=await service.state({employeeId:'operator',name:'Operator'},'operator');assert.equal(state.conversations.length,2);
 assert.equal(state.conversations.find(c=>c.id==='cw_1').syncPending,true);assert.equal(state.conversations.find(c=>c.id==='cw_2').title,'original question');assert.equal(state.conversations.find(c=>c.id==='cw_2').preview,'latest visible');
});
