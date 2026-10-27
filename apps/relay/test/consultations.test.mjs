import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { RelayStore } from "../server/store.mjs";
import {
  activateFromMessages,
  ConsultationWorker,
} from "../server/consultations.mjs";

const source = new URL(
  "../server/modules/relay/relay-chatwoot.service.ts",
  import.meta.url,
).pathname;
const fixture = mkdtempSync(join(tmpdir(), "relay-service-"));
await build({
  entryPoints: [source],
  platform: "node",
  target: "node24",
  bundle: true,
  format: "cjs",
  outfile: join(fixture, "service.cjs"),
  logLevel: "silent",
});
const { RelayChatwootService } = createRequire(import.meta.url)(
  join(fixture, "service.cjs"),
);
process.on("exit", () => rmSync(fixture, { recursive: true, force: true }));
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-first-message-"));
  let store = new RelayStore(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new RelayStore(dir);
      return store;
    },
  };
}
const row = {
  id: "cw_1_7",
  principal: "p",
  app: "kick",
  remote_id: 7,
  source_id: "s",
  created_at: new Date().toISOString(),
};

test("opening alone is not an inquiry; text and attachment delivery activate exactly once through the real service", async (t) => {
  const state = setup(t),
    s = state.store;
  let writes = 0;
  const messages = [];
  const chat = {
    config: () => ({ accountId: 1, apps: { kick: { inboxId: 3 } } }),
    contact: () => "/contact",
    contactInput: () => ({}),
    account: (x) => x,
    messages: async () => messages,
    request: async (path, opts = {}) => {
      if (path === "/contact") return { source_id: "s", id: 1 };
      if (path.startsWith("/contact/")) return {};
      if (path === "/conversations") return { id: 7, inbox_id: 3 };
      if (path === "/conversations/7")
        return {
          id: 7,
          inbox_id: 3,
          status: "open",
          meta: { sender: { name: "Test" } },
        };
      if (path.startsWith("/conversations/7/messages") && !opts.method) return {payload:messages};
      if (path === "/conversations/7/messages") {
        writes++;
        const body = opts.body || {
          content: opts.form.get("content"),
          private: false,
          content_attributes: JSON.parse(opts.form.get("content_attributes")),
        };
        const m = {
          id: writes,
          created_at: Math.floor(Date.now() / 1000),
          message_type: 0,
          ...body,
        };
        if (opts.form) m.attachments = [{ id: 99 }];
        messages.push(m);
        return m;
      }
      throw Error("Unexpected mock route " + path);
    },
  };
  const service = new RelayChatwootService(
    chat,
    s,
    {},
    s,
    {},
    {},
    { allowed: async () => true },
    s,
  );
  const customer = {
    relayPrincipal: "p",
    relayCustomer: true,
    relayApp: "kick",
    employeeId: "u",
    name: "Test",
  };
  const operator = { employeeId: "staff", name: "Staff" };
  const begin = await service.begin(customer, "kick", "begin-123");
  assert.equal(begin.id, row.id);
  assert.equal(
    (await service.state(customer, "customer")).conversations.length,
    1,
  );
  assert.equal(
    (await service.state(operator, "operator")).conversations.length,
    0,
  );
  await assert.rejects(service.claim(row.id, operator), /用户尚未发送消息/);
  assert.equal(await s.nextNotice(), null);
  await assert.rejects(
    service.send(row.id, customer, { content: "   " }, "blank-123", false),
  );
  assert.equal(writes, 0);
  assert.equal(await s.nextNotice(), null);
  const sent = await service.send(
    row.id,
    customer,
    { content: "Help" },
    "message-123",
    false,
  );
  assert.equal(sent.id, "1");
  assert.equal((await s.conversations()).length, 1);
  await service.send(
    row.id,
    customer,
    { content: "Help" },
    "message-123",
    false,
  );
  assert.equal(writes, 1, "same-key retry must not resend");
  const notice = await s.nextNotice();
  assert.ok(notice);
  await s.noticeResult(notice.id, notice.lease, "sent", "om_test");
  await service.send(
    row.id,
    customer,
    {
      content: "",
      attachments: [
        {
          name: "sample.txt",
          kind: "file",
          size: "2 B",
          data: "data:text/plain;base64,aGk=",
        },
      ],
    },
    "file-1234",
    false,
  );
  assert.equal(writes, 2);
  assert.equal(
    await s.nextNotice(),
    null,
    "follow-up attachment must not re-notify",
  );
  assert.equal(
    (await service.state(operator, "operator")).conversations.length,
    1,
  );
  await s.claim(row.id, {
    id: "staff",
    name: "真实接待人",
    claimedAt: row.created_at,
  });
  messages.push({
    id: 3,
    message_type: 1,
    content: "已回复",
    created_at: Math.floor(Date.now() / 1000),
    content_attributes: { relay_sender_name: "真实接待人" },
  });
  const customerState = await service.state(customer, "customer");
  assert.equal(customerState.conversations[0].owner, "小助手");
  assert.equal(customerState.conversations[0].receptionist.id, undefined);
  assert.equal(
    customerState.conversations[0].messages.at(-1).senderName,
    "小助手",
  );
  assert.equal(JSON.stringify(customerState).includes("真实接待人"), false);
  assert.equal(
    (await service.state(operator, "operator")).conversations[0].owner,
    "真实接待人",
  );
});

test("recovery ignores activity, private notes and empty incoming messages; attachment-only is a real inquiry", async (t) => {
  const { store: s } = setup(t);
  await s.register(row, "Test");
  for (const m of [
    { message_type: 2, content: "Conversation opened" },
    { message_type: 1, content: "Welcome" },
    { message_type: 0, private: true, content: "Private" },
    { message_type: 0, content: "  " },
  ]) {
    assert.equal(await activateFromMessages(s, row, [{ id: 1, ...m }]), false);
  }
  assert.equal((await s.conversations()).length, 0);
  assert.equal(await s.nextNotice(), null);
  assert.equal(
    await activateFromMessages(s, row, [
      {
        id: 2,
        message_type: 0,
        content: "",
        attachments: [{ id: 9 }],
        created_at: 1760000000,
      },
    ]),
    true,
  );
  assert.equal((await s.conversations()).length, 1);
  assert.ok(await s.nextNotice());
});

test("restart recovers an accepted message even without its HTTP receipt; empty legacy notices stay suppressed", async (t) => {
  const state = setup(t);
  await state.store.register(row, "Test");
  // An old release could queue a notice before any customer message existed.
  state.store.db
    .prepare(
      "INSERT INTO notices(id,conversation_id,app,name) VALUES('legacy',?,'kick','Test')",
    )
    .run(row.id);
  const s = state.restart();
  assert.equal(await s.nextNotice(), null);
  assert.equal((await s.conversations()).length, 0);
  let messages = [];
  const chat = {
    config: () => ({ apps: { kick: {} } }),
    account: (x) => x,
    request: async () => ({ status: "open" }),
    messages: async () => messages,
  };
  const worker = new ConsultationWorker(chat, s);
  await worker.once();
  assert.equal(await s.nextNotice(), null);
  messages = [
    {
      id: 10,
      message_type: 0,
      content: "Confirmed remotely",
      created_at: 1760000000,
    },
  ];
  s.db.prepare("UPDATE consultations SET next_check_at=0").run();
  await worker.once();
  assert.equal((await s.conversations()).length, 1);
  const notice = await s.nextNotice();
  assert.notEqual(
    notice.id,
    "legacy",
    "a false legacy alert needs a new delivery key for the first real message",
  );
  await s.noticeResult(notice.id, notice.lease, "sent", "om_one");
  await worker.once();
  assert.equal(await s.nextNotice(), null);
});

test("recovery shutdown waits for in-flight reads without closing storage early", async (t) => {
  const { store: s } = setup(t);
  await s.register(row, "Test");
  let done;
  const gate = new Promise((r) => (done = r));
  const worker = new ConsultationWorker(
    {
      config: () => ({ apps: { kick: {} } }),
      account: (x) => x,
      request: async () => ({ status: "open" }),
      messages: async () => {
        await gate;
        return [{ id: 1, message_type: 0, content: "Hi" }];
      },
    },
    s,
  );
  worker.start();
  await new Promise((r) => setImmediate(r));
  let stopped = false;
  const stop = worker.stop().then(() => (stopped = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, false);
  done();
  await stop;
  assert.equal((await s.conversations()).length, 1);
});

test("a lost send receipt is recovered with the same key, without duplicate messages or notifications", async (t) => {
  const { store: s } = setup(t);
  await s.register(row, "Test");
  let writes = 0;
  const messages = [];
  const chat = {
    config: () => ({ apps: { kick: { inboxId: 3 } } }),
    account: (x) => x,
    messages: async () => messages,
    request: async (path, options = {}) => {
      if (path === "/conversations/7") return { inbox_id: 3 };
      writes++;
      messages.push({ id: 31, message_type: 0, ...options.body });
      throw Error("response lost after remote acceptance");
    },
  };
  const service = new RelayChatwootService(chat, s, {}, s, {}, {}, {}, s);
  const customer = {
    relayPrincipal: "p",
    relayCustomer: true,
    relayApp: "kick",
    employeeId: "u",
    name: "Test",
  };
  await assert.rejects(
    service.send(row.id, customer, { content: "Help" }, "unknown-123", false),
  );
  assert.equal(
    await s.nextNotice(),
    null,
    "an unconfirmed send must not notify yet",
  );
  assert.equal((await s.conversations()).length, 0);
  const result = await service.send(
    row.id,
    customer,
    { content: "Help" },
    "unknown-123",
    false,
  );
  assert.equal(result.id, "31");
  assert.equal(writes, 1);
  await new ConsultationWorker(chat, s).once();
  const notice = await s.nextNotice();
  assert.ok(notice);
  assert.equal(await s.nextNotice(), null);
});

test("importing an already ended consultation preserves its history without sending an old inquiry alert", async (t) => {
  const { store: s } = setup(t);
  await s.register(row, "Test");
  await activateFromMessages(
    s,
    row,
    [{ id: 90, message_type: 0, content: "Old consultation" }],
    false,
  );
  assert.equal((await s.conversations()).length, 1);
  assert.equal(await s.nextNotice(), null);
});

test('customer reply unread state is not reused as operator inbox unread',async t=>{
 const {store}=setup(t);await store.register(row,'Test');await store.activate(row.id,'1',new Date().toISOString(),false);
 const messages=[{id:1,message_type:0,private:false,content:'Help',created_at:store.unreadEpoch()/1000+1},{id:2,message_type:1,private:false,content:'Reply',created_at:store.unreadEpoch()/1000+2},{id:3,message_type:1,private:true,content:'Note',created_at:store.unreadEpoch()/1000+3}];
 const chat={config:()=>({apps:{kick:{inboxId:3}}}),account:p=>p,messages:async()=>messages,request:async path=>path.includes('/messages')?{payload:messages.filter(m=>m.id>Number(new URL(path,'https://test').searchParams.get('after')||0))}:{inbox_id:3,status:'open'}};
 const service=new RelayChatwootService(chat,store,{}, {read:async()=>null},{},{},{allowed:async()=>true},store);
 const customer={relayPrincipal:'p',relayCustomer:true,relayApp:'kick',employeeId:'u',name:'Test'};
 const c=(await service.state(customer,'customer')).conversations[0];assert.equal(c.unread,true);assert.deepEqual(c.unreadMessageIds,['2']);assert.equal(c.messages.some(m=>m.id==='3'),false);
 const operator=(await service.state({employeeId:'staff',name:'Staff'},'operator')).conversations[0];assert.equal(operator.unread,true);assert.deepEqual(operator.unreadMessageIds,['1']);
 await service.read(row.id,{employeeId:'staff',name:'Staff'},{messageId:'1'},true);
 assert.deepEqual(store.attention.unread(row.id,'staff'),[]);
});
