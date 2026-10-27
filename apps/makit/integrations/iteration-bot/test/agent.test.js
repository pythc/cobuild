import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentPrompt,
  createFeishuAgent,
  limitAgentReply,
  unwrapTemplateReply
} from "../src/agent.js";

const config = {
  llm: {},
  runtime: {
    larkCliPath: "/opt/homebrew/bin/lark-cli",
    agentLarkCliPath: "/project/src/agent-lark-cli.js",
    agentReplyMaxChars: 600
  },
  tables: {
    requirements: "tbl_req",
    iterations: "tbl_iter",
    bindings: "tbl_bind",
    operations: "tbl_operations",
    collaboration: "tbl_collaboration"
  }
};

const context = {
  chatId: "oc_chat",
  chatType: "group",
  senderId: "ou_owner",
  notificationMode: "live",
  conversation: [],
  baseToken: "base_token",
  baseUrl: "https://example.test/base/base_token?block=dashboard",
  requirementPlatformUrl: "https://requirements.example.test/app",
  cockpitUrl: "https://example.test/cockpit",
  tables: config.tables,
  identities: { base: "user", messages: "bot" },
  timezone: "Asia/Shanghai",
  replyTemplates: {
    success: "已完成：{result}",
    query: "{result}",
    failed: "处理失败：{reason}"
  }
};

test("纯飞书 Agent 由 Codex 在单次会话中直接执行", async () => {
  const agent = createFeishuAgent(config, process.cwd(), null, {
    invoke: async (prompt) => {
      assert.match(prompt, /完整 Shell 权限/);
      assert.match(prompt, /没有工具 broker/);
      assert.match(prompt, /\/project\/src\/agent-lark-cli\.js/);
      return "已确认可用的 Base 操作。";
    }
  });
  assert.equal(await agent.execute("看看 Base 能做什么", context), "已确认可用的 Base 操作。");
});

test("Agent 提示词包含真实资源和群上下文", () => {
  const prompt = buildAgentPrompt("更新需求状态", context);
  assert.match(prompt, /base_token/);
  assert.match(prompt, /https:\/\/requirements\.example\.test\/app/);
  assert.match(prompt, /tbl_req/);
  assert.match(prompt, /tbl_operations/);
  assert.match(prompt, /tbl_collaboration/);
  assert.match(prompt, /oc_chat/);
  assert.match(prompt, /已完成：\{result\}/);
  assert.match(prompt, /普通多项结果最多 3 个短要点/);
  assert.match(prompt, /Agent 专用 lark-cli 代理/);
  assert.match(prompt, /不得查找或调用真实 lark-cli 路径规避门禁/);
  assert.match(prompt, /当前处于正式通知模式/);
  assert.match(prompt, /需求评审时间、开发启动时间、提测时间、发布时间/);
  assert.match(prompt, /base \+record-upsert/);
  assert.match(prompt, /里程碑：需求评审8月9日、开发时间8月23日/);
  assert.match(prompt, /只有一个进行中或规划中的可用迭代/);
  assert.match(prompt, /迭代「<迭代名称>」里程碑已更新/);
  assert.match(prompt, /最多列出 4 个本次更新的时间点/);
  assert.match(prompt, /src\/milestone-reminder\.js --chat-id oc_chat/);
  assert.match(prompt, /测试中且已经超过提测时间/);
  assert.match(prompt, /全部逾期需求/);
  assert.match(prompt, /需求消息硬性约定/);
  assert.match(prompt, /“需求介绍”字段使用 Markdown/);
  assert.match(prompt, /每一项需求都必须同时包含/);
  assert.match(prompt, /需求平台直达链接/);
  assert.doesNotMatch(prompt, /feishu\.cn\/base\/.*record=/);
  assert.match(prompt, /真正 @“当前处理人”/);
  assert.match(prompt, /请相关人员尽快推进，并及时更新状态和进展/);
  assert.match(prompt, /manager-action\.js --chat-id oc_chat --action collect/);
  assert.match(prompt, /一键更新”表示一键收集进展/);
  assert.match(prompt, /group-action\.js --action create/);
  assert.match(prompt, /重复“创建需求群”不会新建重复群/);
});

test("Agent 多轮上下文中的旧 Base 链接先改写再进入提示词", () => {
  const prompt = buildAgentPrompt("继续", {
    ...context,
    conversation: [{
      user: "看看这个需求",
      assistant: "https://fcncvoyreb8p.feishu.cn/base/token?table=tbl_req&record=rec_1"
    }]
  });
  assert.match(prompt, /https:\/\/requirements\.example\.test\/app\/requirements\/rec_1/);
  assert.doesNotMatch(prompt, /feishu\.cn\/base\/token/);
});

test("Agent 回复有最终长度上限", () => {
  assert.equal(limitAgentReply("123456", 5), "1234…");
});

test("Agent 不会把回复模板包装成 JSON 发给用户", () => {
  assert.equal(
    unwrapTemplateReply('{"query":"迭代列表：S1（进行中）"}', context.replyTemplates),
    "迭代列表：S1（进行中）"
  );
});
