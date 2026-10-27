import test from "node:test";
import assert from "node:assert/strict";
import { createManagementController } from "../src/management.js";

test("一键操作先清空开关再发群消息并回写结果", async () => {
  const updates = [];
  const messages = [];
  const operation = {
    recordId: "rec_operation",
    iterationIds: ["rec_iteration"],
    collectProgress: true,
    remind: false,
    fields: {
      "执行状态": ["已完成"],
      "更新时间": "2026-07-30 12:00:00"
    }
  };
  const iteration = {
    recordId: "rec_iteration",
    fields: { "迭代名称": "S1" }
  };
  const base = {
    valueText(value) {
      if (Array.isArray(value)) return value[0] || "";
      return String(value || "");
    },
    async listManagementOperations() {
      return [operation];
    },
    async updateManagementOperation(_recordId, fields) {
      updates.push(fields);
      if (Object.hasOwn(fields, "一键收集进展")) {
        operation.collectProgress = fields["一键收集进展"];
      }
      if (Object.hasOwn(fields, "一键催办")) {
        operation.remind = fields["一键催办"];
      }
    },
    async getIterationById() {
      return iteration;
    },
    async listRequirements() {
      return [{
        recordId: "rec_requirement",
        title: "需求一",
        status: "开发中",
        priority: "P1",
        latestProgress: "开发中",
        updatedAt: "2026-07-20 10:00:00",
        handlers: [{ id: "ou_owner", name: "负责人" }],
        developers: [],
        testers: [],
        productOwners: []
      }];
    },
    async listBindingsForIteration() {
      return [{ fields: { "群聊ID": "oc_group" } }];
    }
  };
  const config = {
    baseUrl: "https://example.test/base/token",
    requirementPlatformUrl: "https://requirements.example.test/app",
    tables: { requirements: "tbl_requirements" },
    runtime: {
      timezone: "Asia/Shanghai",
      managementProcessingTimeoutSeconds: 300,
      maxRequirementLines: 20
    }
  };
  const controller = createManagementController({
    config,
    base,
    now: () => new Date("2026-07-30T12:30:00+08:00"),
    async sendMarkdown(chatId, markdown, key) {
      messages.push({ chatId, markdown, key });
    }
  });

  const result = await controller.runPendingOperations();
  assert.equal(result[0].ok, true);
  assert.deepEqual(updates[0]["一键收集进展"], false);
  assert.equal(updates[0]["执行状态"], "处理中");
  assert.equal(updates.at(-1)["执行状态"], "已完成");
  assert.match(updates.at(-1)["执行结果"], /已发送 1 条消息/);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].chatId, "oc_group");
  assert.match(messages[0].markdown, /https:\/\/requirements\.example\.test\/app\/requirements\/rec_requirement/);
  assert.match(messages[0].markdown, /<at user_id="ou_owner">负责人<\/at>/);

  await controller.runPendingOperations();
  assert.equal(messages.length, 1);
});

test("通知隔离时操作中心明确记账为拦截而不是已发送", async () => {
  const updates = [];
  const operation = {
    recordId: "rec_operation",
    iterationIds: ["rec_iteration"],
    collectProgress: true,
    remind: false,
    fields: {}
  };
  const base = {
    valueText: (value) => String(value || ""),
    listManagementOperations: async () => [operation],
    updateManagementOperation: async (_recordId, fields) => {
      updates.push(fields);
      if (Object.hasOwn(fields, "一键收集进展")) {
        operation.collectProgress = fields["一键收集进展"];
      }
    },
    getIterationById: async () => ({
      recordId: "rec_iteration",
      fields: { "迭代名称": "S1" }
    }),
    listRequirements: async () => [{
      recordId: "rec_requirement",
      title: "需求一",
      status: "开发中",
      latestProgress: "",
      updatedAt: "2026-07-20 10:00:00",
      handlers: [{ id: "ou_owner", name: "负责人" }],
      developers: [],
      testers: [],
      productOwners: []
    }],
    listBindingsForIteration: async () => [{ fields: { "群聊ID": "oc_external" } }]
  };
  const controller = createManagementController({
    config: {
      baseUrl: "https://example.test/base/token",
      requirementPlatformUrl: "https://requirements.example.test/app",
      tables: { requirements: "tbl_requirements" },
      runtime: { timezone: "Asia/Shanghai", managementProcessingTimeoutSeconds: 300 }
    },
    base,
    now: () => new Date("2026-07-30T12:30:00+08:00"),
    sendMarkdown: async () => ({ blocked: true, delivered: false })
  });

  const result = await controller.runPendingOperations();
  assert.equal(result[0].sentMessages, 0);
  assert.equal(result[0].blockedMessages, 1);
  assert.match(updates.at(-1)["执行结果"], /通知隔离期已拦截 1 条群消息/);
  assert.doesNotMatch(updates.at(-1)["执行结果"], /已发送/);
});

test("ownerOnly 下拒绝非管理员触发操作中心", async () => {
  const updates = [];
  const base = {
    valueText: (value) => String(value || ""),
    async listManagementOperations() {
      return [{
        recordId: "rec_operation",
        iterationIds: ["rec_iteration"],
        updatedByIds: ["ou_other"],
        collectProgress: false,
        remind: true,
        fields: {}
      }];
    },
    async updateManagementOperation(_recordId, fields) {
      updates.push(fields);
    },
    async getIterationById() {
      throw new Error("不应读取迭代");
    }
  };
  const controller = createManagementController({
    config: {
      authorization: { ownerOnly: true, ownerOpenIds: ["ou_owner"] },
      runtime: { managementProcessingTimeoutSeconds: 300 }
    },
    base,
    async sendMarkdown() {
      throw new Error("不应发送消息");
    }
  });

  const result = await controller.runPendingOperations();
  assert.equal(result[0].ok, false);
  assert.equal(updates[0]["一键催办"], false);
  assert.equal(updates[0]["执行状态"], "失败");
  assert.match(updates[0]["执行结果"], /无权/);
});

test("没有符合条件的需求时完成记账但不发送群消息", async () => {
  const updates = [];
  const messages = [];
  const operation = {
    recordId: "rec_operation",
    iterationIds: ["rec_iteration"],
    collectProgress: false,
    remind: true,
    fields: {}
  };
  const base = {
    valueText: (value) => String(value || ""),
    async listManagementOperations() {
      return [operation];
    },
    async updateManagementOperation(_recordId, fields) {
      updates.push(fields);
      if (Object.hasOwn(fields, "一键催办")) {
        operation.remind = fields["一键催办"];
      }
    },
    async getIterationById() {
      return {
        recordId: "rec_iteration",
        fields: {
          "迭代名称": "S1",
          "发布时间": "2026-08-31"
        }
      };
    },
    async listRequirements() {
      return [{
        recordId: "rec_safe",
        title: "正常推进",
        status: "开发中",
        priority: "P2",
        deadline: "2026-08-20",
        handlers: [{ id: "ou_owner", name: "负责人" }],
        developers: [],
        testers: [],
        productOwners: []
      }];
    },
    async listBindingsForIteration() {
      return [{ fields: { "群聊ID": "oc_group" } }];
    }
  };
  const controller = createManagementController({
    config: {
      baseUrl: "https://example.test/base/token",
      requirementPlatformUrl: "https://requirements.example.test/app",
      tables: { requirements: "tbl_requirements" },
      runtime: {
        timezone: "Asia/Shanghai",
        managementProcessingTimeoutSeconds: 300
      }
    },
    base,
    now: () => new Date("2026-07-31T12:00:00+08:00"),
    async sendMarkdown(...args) {
      messages.push(args);
    }
  });

  const result = await controller.runPendingOperations();
  assert.equal(result[0].ok, true);
  assert.equal(result[0].targetRequirementCount, 0);
  assert.equal(messages.length, 0);
  assert.match(updates.at(-1)["执行结果"], /未发送群消息/);
});
