import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { createServer } from "node:http";
import * as channel from "../packages/service/channel.mjs";
const adapters = [channel];
for (const path of [
  "../apps/makit/server/common/selfhost/suite-channel.ts",
  "../integrations/weknow/source/apps/server/src/core/auth/feishu/suite-channel.ts",
]) {
  const js = stripTypeScriptTypes(
    readFileSync(new URL(path, import.meta.url), "utf8").replace("'./suite-backchannel'", JSON.stringify(new URL('../packages/service/backchannel.mjs', import.meta.url).href)),
  );
  adapters.push(
    await import(
      "data:text/javascript;base64," + Buffer.from(js).toString("base64")
    ),
  );
}
test('container backchannel retains the configured public Host and signed path', fixture(async(dir)=>{
  const keyFile=join(dir,'service.key');channel.serviceKey(keyFile,true);
  const server=createServer(async(req,res)=>{
    const parts=[];for await(const p of req)parts.push(p);
    const payload=channel.verifyService(req.headers,JSON.parse(Buffer.concat(parts)),req.url,keyFile);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({host:req.headers.host,payload}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const previous=process.env.COBUILD_BACKCHANNELS;
  try {
    process.env.COBUILD_BACKCHANNELS=JSON.stringify({'https://identity.example.test':'http://127.0.0.1:'+server.address().port});
    for(const adapter of adapters){
      const result=await adapter.serviceRequest('https://identity.example.test','/signed',{value:'local'},keyFile);
      assert.equal(result.host,'identity.example.test');assert.equal(result.payload.value,'local');
    }
  } finally {
    if(previous===undefined)delete process.env.COBUILD_BACKCHANNELS;else process.env.COBUILD_BACKCHANNELS=previous;
    await new Promise(r=>server.close(r));
  }
}));
function fixture(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "suite-channel-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
function envelope(key, path, payload = { organizationId: "local-test" }) {
  const body = { at: Date.now(), nonce: "a".repeat(32), payload };
  return {
    body,
    headers: {
      "x-cobuild-signature": createHmac("sha256", key)
        .update(path + "\n" + JSON.stringify(body))
        .digest("hex"),
    },
  };
}
test(
  "all three adapters accept the same path-bound wire format and reject tampering",
  fixture(async (dir) => {
    const file = join(dir, "service.key"),
      key = channel.serviceKey(file, true),
      path = "/api/suite/services/makit/directory";
    for (const adapter of adapters) {
      const { body, headers } = envelope(key, path);
      assert.deepEqual(
        adapter.verifyService(headers, body, path, file),
        body.payload,
      );
      assert.throws(
        () => adapter.verifyService(headers, body, path + "/other", file),
        { status: 401 },
      );
      assert.throws(
        () =>
          adapter.verifyService(
            headers,
            { ...body, payload: { organizationId: "other" } },
            path,
            file,
          ),
        { status: 401 },
      );
      assert.throws(
        () =>
          adapter.verifyService(
            { ...headers, origin: "https://attacker.invalid" },
            body,
            path,
            file,
          ),
        { status: 401 },
      );
      assert.throws(
        () =>
          adapter.verifyService(
            { ...headers, "sec-fetch-site": "same-origin" },
            body,
            path,
            file,
          ),
        { status: 401 },
      );
      assert.throws(
        () =>
          adapter.verifyService(
            headers,
            { ...body, at: Date.now() - 61000 },
            path,
            file,
          ),
        { status: 401 },
      );
    }
  }),
);
test(
  "private service keys reject world-readable files, symlinks and mismatched keys",
  fixture(async (dir) => {
    const file = join(dir, "service.key"),
      key = channel.serviceKey(file, true),
      other = join(dir, "other.key");
    channel.serviceKey(other, true);
    const { body, headers } = envelope(key, "/path");
    for (const adapter of adapters)
      assert.throws(
        () => adapter.verifyService(headers, body, "/path", other),
        { status: 401 },
      );
    chmodSync(file, 0o644);
    for (const adapter of adapters)
      assert.throws(() => adapter.serviceKey(file));
    chmodSync(file, 0o600);
    symlinkSync(file, join(dir, "linked.key"));
    for (const adapter of adapters)
      assert.throws(() => adapter.serviceKey(join(dir, "linked.key")));
  }),
);
test(
  "independent service clients interoperate and reject a redirect to another origin",
  fixture(async (dir) => {
    const file = join(dir, "service.key");
    channel.serviceKey(file, true);
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks));
      const value = channel.verifyService(req.headers, body, req.url, file);
      if (value.redirect) {
        res.writeHead(302, { Location: "https://attacker.invalid/" });
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ accepted: value.organizationId }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = "http://127.0.0.1:" + server.address().port;
    try {
      for (const adapter of adapters) {
        assert.deepEqual(
          await adapter.serviceRequest(
            origin,
            "/path",
            { organizationId: "local-test" },
            file,
          ),
          { accepted: "local-test" },
        );
        await assert.rejects(
          adapter.serviceRequest(origin, "/path", { redirect: true }, file),
        );
        await assert.rejects(
          adapter.serviceRequest("http://remote.invalid", "/path", {}, file),
        );
      }
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }),
);
