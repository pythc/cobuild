import test from "node:test";
import assert from "node:assert/strict";
import { createBaseStore } from "../src/base.js";

const config = {
  baseToken: "base_test",
  tables: {
    requirements: "tbl_requirements",
    iterations: "tbl_iterations",
    bindings: "tbl_bindings",
    operations: "tbl_operations",
    collaboration: "tbl_collaboration"
  },
  identities: { base: "user" },
  runtime: { timezone: "Asia/Shanghai" }
};

test("正确解析 record-list 的信封，不把 data 行数组当成信封", async () => {
  const cli = {
    async json() {
      return {
        ok: true,
        data: {
          data: [["迭代 A", ["进行中"], true]],
          fields: ["迭代名称", "状态", "允许群绑定"],
          record_id_list: ["rec_a"],
          has_more: false
        }
      };
    }
  };
  const store = createBaseStore(config, cli);
  const rows = await store.listIterations();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recordId, "rec_a");
  assert.equal(rows[0].fields["迭代名称"], "迭代 A");
});

test("带发布时间的绑定查询优先匹配规范迭代名", async () => {
  const cli = {
    async json() {
      return {
        ok: true,
        data: {
          data: [
            ["批改系统1.0.1", ["规划中"], true],
            ["批改系统1.0.1，发布时间9月15日", ["规划中"], true]
          ],
          fields: ["迭代名称", "状态", "允许群绑定"],
          record_id_list: ["rec_canonical", "rec_legacy"],
          has_more: false
        }
      };
    }
  };
  const store = createBaseStore(config, cli);
  const result = await store.resolveIteration("批改系统1.0.1，发布时间9月15日");
  assert.equal(result.match.recordId, "rec_canonical");
});

test("删除迭代时保留需求并停用关联群绑定", async () => {
  const calls = [];
  const cli = {
    async json(args) {
      calls.push(args);
      const tableId = args[args.indexOf("--table-id") + 1];
      if (args[1] === "+record-delete") return { ok: true };
      if (args[1] === "+record-upsert") return { ok: true };
      if (tableId === "tbl_requirements") {
        return {
          data: {
            fields: ["需求", "所属迭代"],
            data: [["需求一", [{ id: "rec_iter" }]]],
            record_id_list: ["rec_req"],
            has_more: false
          }
        };
      }
      if (tableId === "tbl_bindings") {
        return {
          data: {
            fields: ["群聊ID", "绑定迭代", "迭代名称", "是否启用"],
            data: [["oc_chat", [{ id: "rec_iter" }], "迭代 A", true]],
            record_id_list: ["rec_binding"],
            has_more: false
          }
        };
      }
      if (tableId === "tbl_iterations") {
        return {
          data: {
            fields: ["迭代名称"],
            data: [],
            record_id_list: [],
            has_more: false
          }
        };
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    }
  };

  const store = createBaseStore(config, cli);
  const result = await store.deleteIteration({
    recordId: "rec_iter",
    fields: { "迭代名称": "迭代 A" }
  });

  assert.deepEqual(result, {
    requirementCount: 1,
    disabledBindingCount: 1
  });
  const deleteCall = calls.find((args) => args[1] === "+record-delete");
  assert.ok(deleteCall.includes("--yes"));
  assert.ok(deleteCall.includes("rec_iter"));
  const bindingUpdate = calls.find((args) =>
    args[1] === "+record-upsert" && args.includes("rec_binding")
  );
  assert.match(bindingUpdate[bindingUpdate.indexOf("--json") + 1], /"是否启用":false/);
});

test("操作中心解析迭代关联和两个一键开关", async () => {
  const calls = [];
  const cli = {
    async json(args) {
      calls.push(args);
      if (args[1] === "+record-upsert") return { ok: true };
      return {
        data: {
          fields: ["操作项", "迭代", "一键收集进展", "一键催办", "执行状态"],
          data: [["迭代 A｜管理操作", [{ id: "rec_iter" }], true, false, ["已完成"]]],
          record_id_list: ["rec_operation"],
          has_more: false
        }
      };
    }
  };

  const store = createBaseStore(config, cli);
  const operations = await store.listManagementOperations();
  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0].iterationIds, ["rec_iter"]);
  assert.equal(operations[0].collectProgress, true);
  assert.equal(operations[0].remind, false);

  await store.updateManagementOperation("rec_operation", { "执行状态": "处理中" });
  const update = calls.find((args) => args[1] === "+record-upsert");
  assert.ok(update.includes("rec_operation"));
  assert.match(update[update.indexOf("--json") + 1], /"执行状态":"处理中"/);
});

test("需求记录包含群聊协作字段并可按 id 回读", async () => {
  const cli = {
    async json() {
      return {
        data: {
          fields: [
            "需求", "需求介绍", "所属迭代", "当前处理人", "最后修改人",
            "需求群ID", "需求群链接", "拉群状态"
          ],
          data: [[
            "需求一",
            "## 背景\n\n保障核心链路。",
            [{ id: "rec_iter" }],
            [{ id: "ou_owner", name: "负责人" }],
            [{ id: "ou_actor", name: "修改人" }],
            "oc_group",
            { text: "打开需求群", link: "https://example.test/group" },
            ["已创建"]
          ]],
          record_id_list: ["rec_req"],
          has_more: false
        }
      };
    }
  };
  const store = createBaseStore(config, cli);
  const requirement = await store.getRequirementById("rec_req");
  assert.equal(requirement.title, "需求一");
  assert.equal(requirement.introduction, "## 背景\n\n保障核心链路。");
  assert.deepEqual(requirement.iterationIds, ["rec_iter"]);
  assert.equal(requirement.handlers[0].id, "ou_owner");
  assert.equal(requirement.modifiedBy.id, "ou_actor");
  assert.equal(requirement.groupChatId, "oc_group");
  assert.equal(requirement.groupLink, "https://example.test/group");
  assert.equal(requirement.groupStatus, "已创建");
});

test("协作事件按事件键幂等写入", async () => {
  const calls = [];
  let created = false;
  const cli = {
    async json(args) {
      calls.push(args);
      if (args[1] === "+record-upsert") {
        created = true;
        return { ok: true };
      }
      return {
        data: {
          fields: ["事件键", "事件类型", "需求", "状态", "尝试次数"],
          data: created ? [["event-key", ["需求新增"], [{ id: "rec_req" }], ["待处理"], 0]] : [],
          record_id_list: created ? ["rec_event"] : [],
          has_more: false
        }
      };
    }
  };
  const store = createBaseStore(config, cli);
  const event = await store.createCollaborationEvent("event-key", {
    "事件类型": "需求新增",
    "需求": [{ id: "rec_req" }],
    "状态": "待处理"
  });
  assert.equal(event.recordId, "rec_event");
  await store.createCollaborationEvent("event-key", { "事件类型": "需求新增" });
  assert.equal(calls.filter((args) => args[1] === "+record-upsert").length, 1);
});
