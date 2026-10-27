import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { notificationDecision, createNotificationGateway } from "../src/notification-gate.js";

const config = { interaction: { enabled: false }, notifications: { mode: "live" }, identities: { messages: "bot" } };

test("disabled interaction blocks replies without blocking business notifications", () => {
  assert.equal(notificationDecision(config, { chatId: "test" }, { purpose: "agent-reply" }).allowed, false);
  assert.equal(notificationDecision(config, { chatId: "test" }, { purpose: "requirement-status" }).allowed, true);
});

test("disabled reply gateway does not call the sender", async () => {
  const gateway = createNotificationGateway({ config, cli: new Proxy({}, {
    get() { throw new Error("sender must not be invoked"); }
  }) });
  const result = await gateway.sendMarkdown("test", "ignored", "test", { purpose: "agent-reply" });
  assert.equal(result.blocked, true);
});

test("event startup and handler both respect interaction switch", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(source, /async function handleEvent\(payload\) \{\s*if \(config\.interaction\?\.enabled === false\) return;/);
  assert.match(source, /if \(config\.interaction\?\.enabled !== false\) \{\s*void eventStream\.start\(handleEvent\)/);
});
