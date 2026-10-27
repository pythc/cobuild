import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {issueWidgetGrant} from '../integrations/widget-issuer.mjs';
import {verifyWidgetGrant} from '../server/widget-grants.mjs';
test('widget grants bind verified app identity, source origin, PKCE and short lifetime',()=>{
 const key=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
 const issuers={grading:{key,apps:['grading-internal'],origins:['https://aigrading.110-lab.cn']}};
 const args={key,issuer:'grading',app:'grading-internal',origin:'https://aigrading.110-lab.cn',subject:'student-1',name:'测试学生',challenge,now:1000000};
 const {grant}=issueWidgetGrant(args);
 assert.equal(verifyWidgetGrant(grant,verifier,issuers,1000001).sub,'student-1');
 assert.throws(()=>verifyWidgetGrant(grant,'x'.repeat(43),issuers,1000001),/不匹配/);
 assert.throws(()=>verifyWidgetGrant(grant,verifier,issuers,1090001),/失效/);
 assert.throws(()=>verifyWidgetGrant(issueWidgetGrant({...args,app:'makit'}).grant,verifier,issuers,1000001),/失效/);
 assert.throws(()=>verifyWidgetGrant(issueWidgetGrant({...args,origin:'https://evil.test'}).grant,verifier,issuers,1000001),/失效/);
 assert.throws(()=>verifyWidgetGrant(grant.slice(0,-8)+'xxxxxxxx',verifier,issuers,1000001),/签名/);
 assert.throws(()=>verifyWidgetGrant(grant,verifier,{},1000001),/未接入/);
});
