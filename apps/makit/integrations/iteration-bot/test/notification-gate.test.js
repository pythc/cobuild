import test from "node:test";
import assert from "node:assert/strict";
import {
  createNotificationGateway,
  notificationDecision
} from "../src/notification-gate.js";

function config(mode = "test_only") {
  return {
    identities: { messages: "bot" },
    notifications: {
      mode,
      allowedUserOpenIds: ["ou_owner"],
      allowedChatIds: ["oc_test"]
    }
  };
}

test("test_only 只允许本人和测试群", () => {
  assert.equal(notificationDecision(config(), { userId: "ou_owner" }).allowed, true);
  assert.equal(notificationDecision(config(), { chatId: "oc_test" }).allowed, true);
  assert.equal(notificationDecision(config(), { userId: "ou_other" }).allowed, false);
  assert.equal(notificationDecision(config(), { chatId: "oc_external" }).allowed, false);
});

test("本人触发的 Agent 回复允许回到当前私聊或群聊", () => {
  const decision = notificationDecision(
    config(),
    { chatId: "oc_owner_conversation" },
    { purpose: "agent-reply", requestedByUserId: "ou_owner" }
  );
  assert.equal(decision.allowed, true);
});

test("非白名单目标不会调用飞书 API", async () => {
  const calls = [];
  const gateway = createNotificationGateway({
    config: config(),
    cli: { json: async (args) => calls.push(args) }
  });
  const blockedUser = await gateway.sendCard(
    { userId: "ou_other" },
    { schema: "2.0" },
    "blocked-user"
  );
  const blockedChat = await gateway.sendMarkdown(
    "oc_external",
    "不应发送",
    "blocked-chat"
  );
  assert.equal(blockedUser.blocked, true);
  assert.equal(blockedChat.blocked, true);
  assert.deepEqual(calls, []);
});

test("白名单目标实际调用一次且 live 模式可发送", async () => {
  const calls = [];
  const gateway = createNotificationGateway({
    config: config(),
    cli: { json: async (args) => { calls.push(args); return { ok: true }; } }
  });
  const result = await gateway.sendMarkdown("oc_test", "测试", "allowed-chat");
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 1);
  assert.equal(notificationDecision(config("live"), { userId: "ou_other" }).allowed, true);
});

test("缺少或非法模式时默认关闭而不是默认放行", () => {
  assert.equal(notificationDecision({ notifications: {} }, { chatId: "oc_test" }).allowed, false);
  assert.equal(notificationDecision({ notifications: { mode: "unknown" } }, { chatId: "oc_test" }).allowed, false);
});

test("工作流通知超过分钟预算后由安全门拦截", async () => {
  const calls = [];
  const limited = config("live");
  limited.notifications.maxWorkflowDeliveriesPerMinute = 2;
  const gateway = createNotificationGateway({
    config: limited,
    cli: { json: async (args) => { calls.push(args); return { ok: true }; } }
  });
  await gateway.sendMarkdown("oc_1", "第一条", "one", { purpose: "workflow" });
  await gateway.sendMarkdown("oc_2", "第二条", "two", { purpose: "workflow" });
  const blocked = await gateway.sendMarkdown(
    "oc_3",
    "第三条",
    "three",
    { purpose: "workflow" }
  );
  assert.equal(blocked.safetyBlocked, true);
  assert.match(blocked.reason, /budget exceeded/);
  assert.equal(calls.length, 2);
});

test("连续发送失败后打开熔断器", async () => {
  const failing = config("live");
  failing.notifications.maxConsecutiveFailures = 2;
  const gateway = createNotificationGateway({
    config: failing,
    cli: { json: async () => { throw new Error("network down"); } }
  });
  await assert.rejects(
    gateway.sendMarkdown("oc_1", "第一条", "one", { purpose: "workflow" })
  );
  await assert.rejects(
    gateway.sendMarkdown("oc_2", "第二条", "two", { purpose: "workflow" })
  );
  const blocked = await gateway.sendMarkdown(
    "oc_3",
    "第三条",
    "three",
    { purpose: "workflow" }
  );
  assert.equal(blocked.safetyBlocked, true);
  assert.match(blocked.reason, /circuit open/);
});
