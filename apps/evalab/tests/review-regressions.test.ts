import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, hashPassword } from '../server/src/security.js';
import { createPool, migrate } from '../server/src/db.js';
import { bootstrapAdmin } from '../server/src/bootstrap.js';
import { loadConfig } from '../server/src/config.js';
import { registerAccount, requestEmailCode } from '../server/src/auth.js';
import { readCodexTranscript } from '../context-bridge/src/codex.js';
import { redactText } from '../context-bridge/src/redact.js';

test('Canonical JSON preserves own __proto__ keys without modifying prototypes',()=>{
  const input=JSON.parse('{"z":1,"__proto__":{"protected":true}}');
  assert.equal(canonicalJson(input),'{"__proto__":{"protected":true},"z":1}');
  assert.equal(({} as Record<string,unknown>).protected,undefined);
});

test('Context projection excludes internal reasoning and system/developer messages',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'lab-context-regression-'));
  try {
    const f=path.join(root,'session.jsonl');
    const row=(role:string,channel:string,text:string)=>({type:'response_item',payload:{type:'message',role,channel,content:[{type:'output_text',text}]}});
    await writeFile(f,[{type:'session_meta',payload:{cwd:root}},row('system','final','hidden system'),row('developer','final','hidden developer'),row('assistant','analysis','private internal reasoning'),row('user','final','帮我运行测试'),row('assistant','commentary','正在检查测试'),row('assistant','final','测试通过')].map(x=>JSON.stringify(x)).join('\n'));
    const result=await readCodexTranscript(f,root);
    assert.deepEqual(result.turns.map(t=>t.text),['帮我运行测试','正在检查测试','测试通过']);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('Common local context secrets are redacted without altering source files',()=>{
  const cursor='crsr_'+'x'.repeat(64);
  const text=`password = "example-pass-123"\n密码：exam-secret-123\n${cursor}\nhttps://name:secret@example.test/repo\n普通项目描述`;
  const result=redactText(text);
  for(const secret of ['example-pass-123','exam-secret-123',cursor,'name:secret@']) assert.equal(result.text.includes(secret),false);
  assert.match(result.text,/普通项目描述/);
});

test('Auth bootstrapping and verification attempts remain durable', {skip:!process.env.REVIEW_DATABASE_URL},async()=>{
  const url=process.env.REVIEW_DATABASE_URL!;
  assert.match(url,/@127\.0\.0\.1:5548\//,'Only isolated local PostgreSQL may be used');
  const schema=`review_${Date.now()}`;
  const pool=createPool(url,schema);
  try {
    await migrate(pool,schema);
    const startup={databaseUrl:url,adminEmail:'review-admin@example.test',adminPassword:'Initial-Password123',adminName:'测试运营'};
    await bootstrapAdmin(pool,startup);
    const changed=await hashPassword('Changed-Password456');
    await pool.query('UPDATE users SET password_hash=$1 WHERE email=$2',[changed,startup.adminEmail]);
    await bootstrapAdmin(pool,startup);
    assert.equal((await pool.query('SELECT password_hash FROM users WHERE email=$1',[startup.adminEmail])).rows[0].password_hash,changed,'Bootstrapping must preserve password resets');
    const {config}=loadConfig({DATABASE_URL:url,DB_SCHEMA:schema,APP_ORIGIN:'http://127.0.0.1:5380',SESSION_SECRET:'local-review-secret-at-least-32-characters',NODE_ENV:'test',MAIL_TEST_SINK:'true'});
    const ctx={pool,config};
    const email='review-candidate@example.test';
    const req=(body:unknown)=>({body,ip:'127.0.0.10',socket:{remoteAddress:'127.0.0.10'}} as never);
    const challenge=await requestEmailCode(ctx,req({email,purpose:'REGISTER'}));
    const emailBody=(await pool.query('SELECT body FROM email_outbox WHERE to_email=$1',[email])).rows[0].body;
    const real=String(emailBody).match(/\b\d{6}\b/)![0];
    const wrong=real==='000000'?'111111':'000000';
    const body={name:'回归测试',studentNo:'2026000099',college:'计算机学院',major:'软件工程',phone:'13800138001',email,password:'Candidate-Test123',challengeId:challenge.challengeId,acceptedPolicy:true};
    for(let i=0;i<5;i++) await assert.rejects(()=>registerAccount(ctx,req({...body,code:wrong})));
    const attempts=(await pool.query('SELECT attempts FROM email_challenges WHERE id=$1',[challenge.challengeId])).rows[0].attempts;
    assert.equal(attempts,5,'Rejected attempts must not roll back');
    await assert.rejects(()=>registerAccount(ctx,req({...body,code:real})),'Correct code must be locked after five failed attempts');
  } finally {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});


test('Quoted credentials, URL schemes and incomplete PEM blocks are fully removed',()=>{
 const input = ['"password": "quoted secret with spaces"', "api_key='another secret with spaces'", 'postgres://user:database-secret@localhost/db', '-----BEGIN RSA PRIVATE KEY-----\nprivate-base64-body'].join('\n');
 const {text}=redactText(input);
 for(const fragment of ['quoted secret','another secret','database-secret','private-base64-body']) assert.equal(text.includes(fragment),false);
 assert.equal(redactText('Use a PRIVATE KEY in the local keychain').text,'Use a PRIVATE KEY in the local keychain');
});
