import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeRequirements,
  classifyMilestoneOverdue,
  formatMilestoneReminder,
  formatProgressCollection,
  formatReport,
  formatReminder
} from "../src/reporter.js";

const requirements = [
  { recordId: "rec_done", title: "已完成", status: "已发布", priority: "P1", handlers: [], developers: [], deadline: "2026-01-01" },
  { recordId: "rec_overdue", title: "逾期需求", status: "开发中", priority: "P0", handlers: [{ id: "ou_1", name: "甲" }], developers: [], deadline: "2026-01-02", blocked: true, blocker: "等待接口" },
  { recordId: "rec_unassigned", title: "无人负责", status: "已评审", priority: "P2", handlers: [], developers: [], deadline: null }
];

test("统计完成、逾期和未分配", () => {
  const result = analyzeRequirements(requirements, Date.parse("2026-02-01"));
  assert.equal(result.total, 3);
  assert.equal(result.done, 1);
  assert.equal(result.overdue.length, 1);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.unassigned.length, 1);
});

test("报告包含关键指标和需求平台精准链接", () => {
  const report = formatReport(
    { fields: { "迭代名称": "S1" } },
    requirements,
    {
      baseUrl: "https://example.test/base/token",
      requirementPlatformUrl: "https://requirements.example.test/app",
      cockpitUrl: "https://example.test/cockpit",
      tables: { requirements: "tbl_req" },
      runtime: { maxRequirementLines: 20 }
    }
  );
  assert.match(report, /完成率 \*\*33%\*\*/);
  assert.match(report, /逾期未完成：\*\*1\*\*/);
  assert.match(report, /当前阻塞：\*\*1\*\*/);
  assert.match(report, /https:\/\/requirements\.example\.test\/app\/requirements\/rec_/);
  assert.match(report, /\[打开当前迭代\]\(https:\/\/requirements\.example\.test\/app\/iterations\)/);
  assert.match(report, /<at user_id="ou_1">甲<\/at>/);
  assert.match(report, /请相关人员尽快推进，并及时更新状态和进展/);
});

test("普通催办为每项需求生成直达链接、@处理人并使用正式收尾", () => {
  const report = formatReminder(
    { fields: { "迭代名称": "S1" } },
    requirements,
    {
      baseUrl: "https://example.test/base/token",
      requirementPlatformUrl: "https://requirements.example.test/app",
      tables: { requirements: "tbl_req" },
      runtime: { maxRequirementLines: 20 }
    }
  );
  assert.match(report, /\[逾期需求\]\(https:\/\/requirements\.example\.test\/app\/requirements\/rec_/);
  assert.match(report, /<at user_id="ou_1">甲<\/at>/);
  assert.match(report, /请相关人员尽快推进，并及时更新状态和进展/);
  assert.doesNotMatch(report, /🎉/);
});

test("没有风险时普通催办不会降级为催办全部未完成需求", () => {
  const report = formatReminder(
    { fields: { "迭代名称": "S1" } },
    [{
      recordId: "rec_safe",
      title: "正常推进需求",
      status: "开发中",
      priority: "P2",
      deadline: "2026-08-31",
      handlers: [{ id: "ou_owner", name: "负责人" }],
      developers: []
    }],
    {
      baseUrl: "https://example.test/base/token",
      requirementPlatformUrl: "https://requirements.example.test/app",
      tables: { requirements: "tbl_req" }
    },
    { now: Date.parse("2026-07-31T12:00:00+08:00") }
  );
  assert.match(report, /当前没有阻塞、截止逾期或未分配的风险需求/);
  assert.doesNotMatch(report, /正常推进需求/);
  assert.doesNotMatch(report, /请相关人员尽快推进/);
});

test("截止日期按上海时区当日结束计算并展示年份", () => {
  const result = analyzeRequirements(
    [{
      title: "今日截止",
      status: "开发中",
      priority: "P1",
      deadline: "2026-07-31",
      handlers: [{ id: "ou_owner", name: "负责人" }],
      developers: []
    }],
    Date.parse("2026-07-31T12:00:00+08:00")
  );
  assert.equal(result.overdue.length, 0);
});

test("里程碑催办按最早未完成阶段归类且每条需求只出现一次", () => {
  const iteration = {
    fields: {
      "迭代名称": "S1",
      "需求评审时间": "2026-08-09 00:00:00",
      "开发启动时间": "2026-08-23 00:00:00",
      "提测时间": "2026-08-30 00:00:00",
      "发布时间": "2026-09-15 00:00:00"
    }
  };
  const people = {
    handlers: [{ id: "ou_handler", name: "处理人" }],
    developers: [{ id: "ou_dev", name: "研发" }],
    testers: [{ id: "ou_test", name: "测试" }],
    productOwners: [{ id: "ou_product", name: "产品" }]
  };
  const items = [
    { recordId: "rec_review", title: "待评审", status: "需求待评审", priority: "P1", ...people },
    { recordId: "rec_dev", title: "仍在开发", status: "开发中", priority: "P0", ...people },
    { recordId: "rec_test", title: "仍在测试", status: "测试中", priority: "P1", ...people },
    { recordId: "rec_release", title: "等待发布", status: "待发布", priority: "P2", ...people },
    { recordId: "rec_done", title: "已完成", status: "已发布", priority: "P2", ...people }
  ];
  const now = Date.parse("2026-09-20T12:00:00+08:00");
  const groups = classifyMilestoneOverdue(iteration, items, now);
  assert.deepEqual(groups.map((group) => group.key), ["review", "development", "testing", "release"]);
  assert.deepEqual(groups.map((group) => group.items.length), [1, 1, 1, 1]);

  const report = formatMilestoneReminder(
    iteration,
    items,
    {
      rec_review: "https://example.test/review",
      rec_dev: "https://example.test/dev",
      rec_test: "https://example.test/test",
      rec_release: "https://example.test/release"
    },
    {
      now,
      config: { requirementPlatformUrl: "https://requirements.example.test/app" }
    }
  );
  assert.match(report, /提测时间已过仍未完成测试/);
  assert.match(report, /\[仍在测试\]\(https:\/\/requirements\.example\.test\/app\/requirements\/rec_test\)/);
  assert.match(report, /<at user_id="ou_handler">处理人<\/at>/);
  assert.match(report, /<at user_id="ou_test">测试<\/at>/);
  assert.equal((report.match(/仍在测试/g) || []).length, 1);
  assert.doesNotMatch(report, /已完成/);
});

test("一键收集进展为每项未发布需求附链接并 @ 全部相关人员", () => {
  const report = formatProgressCollection(
    { fields: { "迭代名称": "S1" } },
    [
      {
        recordId: "rec_active",
        title: "需求一",
        status: "测试中",
        priority: "P1",
        latestProgress: "联调完成",
        updatedAt: "2026-07-20 10:00:00",
        handlers: [{ id: "ou_handler", name: "处理人" }],
        developers: [{ id: "ou_dev", name: "研发" }],
        testers: [{ id: "ou_test", name: "测试" }],
        productOwners: [{ id: "ou_product", name: "产品" }]
      },
      {
        recordId: "rec_done",
        title: "已发布需求",
        status: "已发布",
        priority: "P2",
        handlers: []
      }
    ],
    {
      baseUrl: "https://example.test/base/token",
      requirementPlatformUrl: "https://requirements.example.test/app",
      tables: { requirements: "tbl_req" }
    }
  );
  assert.match(report, /\[需求一\]\(https:\/\/requirements\.example\.test\/app\/requirements\/rec_active\)/);
  assert.match(report, /<at user_id="ou_handler">处理人<\/at>/);
  assert.match(report, /<at user_id="ou_dev">研发<\/at>/);
  assert.match(report, /<at user_id="ou_test">测试<\/at>/);
  assert.match(report, /<at user_id="ou_product">产品<\/at>/);
  assert.doesNotMatch(report, /已发布需求/);
});
