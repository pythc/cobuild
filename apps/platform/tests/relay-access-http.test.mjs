import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createApplicationAccessHttp} from '../server/application-access-http.mjs';
test('Relay scope bridge requires its dedicated machine key and refuses browser-origin calls',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-access-http-')),file=join(dir,'key'),key='fixture_'.repeat(8);await writeFile(file,key,{mode:0o600});const prior=process.env.PORTAL_RELAY_ACCESS_KEY_FILE;process.env.PORTAL_RELAY_ACCESS_KEY_FILE=file;t.after(async()=>{if(prior===undefined)delete process.env.PORTAL_RELAY_ACCESS_KEY_FILE;else process.env.PORTAL_RELAY_ACCESS_KEY_FILE=prior;await rm(dir,{recursive:true,force:true});});let calls=0;
 const http=createApplicationAccessHttp({mail:{},apps:[],access:{relayOperator:async id=>{calls++;return {allowed:id==='ops',revision:1};}}});
 async function request(headers,employeeId='ops'){const req=Readable.from([Buffer.from(JSON.stringify({employeeId}))]);req.method='POST';req.headers={'content-type':'application/json',...headers};let status=0,body;const res={writeHead(s){status=s;this.headersSent=true;},end(s){body=JSON.parse(s);}};await http.handle(req,res,'/api/application-access/service/relay','internal.110-lab.cn');return {status,body};}
 assert.equal((await request({})).status,401);assert.equal(calls,0);
 assert.equal((await request({'x-relay-access-key':key,origin:'https://internal.110-lab.cn'})).status,403);assert.equal(calls,0);
 assert.equal((await request({'x-relay-access-key':key})).body.allowed,true);
 assert.equal((await request({'x-relay-access-key':key},'outside')).body.allowed,false);
});
