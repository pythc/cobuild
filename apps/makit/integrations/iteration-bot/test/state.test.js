import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStateStore } from "../src/state.js";

test("多轮对话按 chat_id 隔离、裁剪并持久化", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "iteration-state-test-"));
  try {
    const store = createStateStore(root, {
      maxConversationTurns: 2,
      maxConversationChats: 10,
      conversationTtlDays: 7
    });
    await store.load();
    await store.appendConversation("chat-a", {
      user: "第一轮",
      assistant: "结果一",
      intent: { type: "report" }
    });
    await store.appendConversation("chat-a", {
      user: "第二轮",
      assistant: "结果二",
      intent: { type: "binding", iterationName: "S1" }
    });
    await store.appendConversation("chat-a", {
      user: "第三轮",
      assistant: "结果三",
      intent: { type: "remind" }
    });
    await store.appendConversation("chat-b", {
      user: "另一个群",
      assistant: "独立结果",
      intent: { type: "help" }
    });

    assert.deepEqual(
      store.getConversation("chat-a").map((turn) => turn.user),
      ["第二轮", "第三轮"]
    );
    assert.deepEqual(
      store.getConversation("chat-b").map((turn) => turn.user),
      ["另一个群"]
    );

    const reloaded = createStateStore(root, {
      maxConversationTurns: 2,
      maxConversationChats: 10,
      conversationTtlDays: 7
    });
    await reloaded.load();
    assert.equal(reloaded.getConversation("chat-a")[0].iterationName, "S1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("需求快照和协作基线可持久化", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "iteration-state-collaboration-"));
  try {
    const store = createStateStore(root);
    await store.load();
    assert.equal(store.isCollaborationBaselineReady(), false);
    await store.setRequirementSnapshot("rec_req", { status: "开发中" });
    await store.markCollaborationBaselineReady();
    await store.setCollaborationSnapshotVersion(1);
    await store.setCollaborationLastScanAt("2026-08-01T01:00:00.000Z");

    const reloaded = createStateStore(root);
    await reloaded.load();
    assert.deepEqual(reloaded.getRequirementSnapshot("rec_req"), { status: "开发中" });
    assert.equal(reloaded.isCollaborationBaselineReady(), true);
    assert.equal(reloaded.getCollaborationSnapshotVersion(), 1);
    assert.equal(
      reloaded.getCollaborationLastScanAt(),
      "2026-08-01T01:00:00.000Z"
    );

    await reloaded.replaceRequirementSnapshots({ rec_other: { status: "测试中" } });
    assert.equal(reloaded.getRequirementSnapshot("rec_req"), null);
    assert.equal(reloaded.getRequirementSnapshot("rec_other").status, "测试中");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("并发状态更新串行落盘且不会争用同一个临时文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "iteration-state-concurrent-"));
  try {
    const store = createStateStore(root);
    await store.load();
    await Promise.all([
      store.appendConversation("chat-a", {
        user: "并发消息",
        assistant: "已处理",
        intent: { type: "agent" }
      }),
      store.markProcessed("om_concurrent"),
      store.markScheduled("schedule-concurrent"),
      store.setRequirementSnapshot("rec_req", { status: "开发中" })
    ]);

    const reloaded = createStateStore(root);
    await reloaded.load();
    assert.equal(reloaded.hasProcessed("om_concurrent"), true);
    assert.equal(reloaded.scheduledKeySent("schedule-concurrent"), true);
    assert.equal(reloaded.getConversation("chat-a")[0].user, "并发消息");
    assert.equal(reloaded.getRequirementSnapshot("rec_req").status, "开发中");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
