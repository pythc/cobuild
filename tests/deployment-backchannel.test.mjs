import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { transportOrigin } from '../packages/service/backchannel.mjs';
const adapters=[transportOrigin];
for (const path of ['../apps/makit/server/common/selfhost/suite-backchannel.ts','../integrations/weknow/source/apps/server/src/core/auth/feishu/suite-backchannel.ts']) {
  const js=stripTypeScriptTypes(readFileSync(new URL(path,import.meta.url),'utf8'));
  adapters.push((await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'))).transportOrigin);
}
test('deployment transport changes exact configured issuer only and never enables external HTTP',()=>{
  const original=process.env.COBUILD_BACKCHANNELS;
  try {
    for(const adapter of adapters) {
      delete process.env.COBUILD_BACKCHANNELS;
      assert.equal(adapter('https://identity.example.test'),'https://identity.example.test');
      process.env.COBUILD_BACKCHANNELS=JSON.stringify({'https://identity.example.test':'http://127.0.0.1:4100'});
      assert.equal(adapter('https://identity.example.test'),'http://127.0.0.1:4100');
      assert.equal(adapter('https://other.example.test'),'https://other.example.test');
      for(const target of ['http://169.254.169.254','http://postgres:5432','http://127.0.0.1:4100/path','http://a:b@127.0.0.1:4100','http://127.0.0.1:4100#bad','https://untrusted.example']) {
        process.env.COBUILD_BACKCHANNELS=JSON.stringify({'https://identity.example.test':target});
        assert.throws(()=>adapter('https://identity.example.test'));
      }
    }
  } finally { if(original===undefined)delete process.env.COBUILD_BACKCHANNELS;else process.env.COBUILD_BACKCHANNELS=original; }
});
