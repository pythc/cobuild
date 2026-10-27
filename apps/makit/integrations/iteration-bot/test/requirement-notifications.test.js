import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRequirementNotificationPlan,
  validateNotificationCard
} from "../src/requirement-notifications.js";

const config = {
  baseToken: "base_test",
  baseUrl: "https://example.test/base/base_test",
  requirementPlatformUrl: "https://requirements.example.test/app",
  botOpenId: "ou_bot",
  tables: { requirements: "tbl_req" },
  authorization: { ownerOpenIds: ["ou_owner"] },
  notifications: {
    defaultActor: { id: "ou_owner", name: "周灿宇" }
  },
  runtime: { timezone: "Asia/Shanghai" }
};

function snapshot(overrides = {}) {
  return {
    title: "网关支持新模型",
    introduction: "",
    iterationIds: ["rec_iter"],
    status: "开发中",
    priority: "P1",
    project: "AI 网关",
    handlers: [{ id: "ou_handler", name: "处理人" }],
    productOwners: [{ id: "ou_product", name: "产品" }],
    developers: [{ id: "ou_dev", name: "研发" }],
    testers: [{ id: "ou_test", name: "测试" }],
    startDate: null,
    deadline: null,
    developmentStart: null,
    developmentEnd: null,
    testDate: null,
    blocked: false,
    blocker: "",
    latestProgress: "",
    modifiedBy: { id: "ou_actor", name: "修改人" },
    ...overrides
  };
}

function requirement(next, overrides = {}) {
  return {
    recordId: "rec_req",
    groupChatId: "oc_requirement",
    ...next,
    ...overrides
  };
}

test("人员字段新增成员时只给新被指派者发送一张工作卡片", () => {
  const previous = snapshot({ handlers: [], developers: [] });
  const next = snapshot({ handlers: [], developers: [{ id: "ou_dev", name: "研发" }] });
  const plans = buildRequirementNotificationPlan({
    config,
    requirement: requirement(next),
    previous,
    next,
    changes: [{
      key: "developers",
      label: "研发人员",
      before: [],
      after: next.developers
    }],
    iterationNames: ["S1"]
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].channel, "user");
  assert.equal(plans[0].targetId, "ou_dev");
  assert.equal(plans[0].kind, "assignment");
  const serialized = JSON.stringify(plans[0].card);
  assert.match(serialized, /您收到一项新的工作/);
  assert.match(serialized, /研发人员/);
  assert.match(serialized, /修改人/);
  assert.match(serialized, /https:\/\/requirements\.example\.test\/app\/requirements\/rec_req/);
  assert.equal(validateNotificationCard(plans[0].card), true);
});

test("其他字段变化没有当前处理人时完全不通知", () => {
  const previous = snapshot({ handlers: [], priority: "P2" });
  const next = snapshot({ handlers: [], priority: "P1" });
  const plans = buildRequirementNotificationPlan({
    config,
    requirement: requirement(next),
    previous,
    next,
    changes: [{ key: "priority", label: "优先级", before: "P2", after: "P1" }],
    iterationNames: ["S1"]
  });
  assert.deepEqual(plans, []);
});

test("状态流转私聊当前处理人并通知需求群的阶段人员", () => {
  const previous = snapshot({ status: "已评审" });
  const next = snapshot({ status: "开发中" });
  const plans = buildRequirementNotificationPlan({
    config,
    requirement: requirement(next),
    previous,
    next,
    changes: [{ key: "status", label: "状态", before: "已评审", after: "开发中" }],
    iterationNames: ["S1"]
  });
  assert.equal(plans.length, 2);
  const direct = plans.find((item) => item.channel === "user");
  const group = plans.find((item) => item.channel === "chat");
  assert.equal(direct.targetId, "ou_handler");
  assert.equal(direct.kind, "status");
  assert.equal(group.targetId, "oc_requirement");
  assert.equal(group.kind, "status-group");
  const serialized = JSON.stringify(group.card);
  assert.match(serialized, /已评审 →/);
  assert.match(serialized, /开发中/);
  assert.ok(serialized.includes("<at id=ou_handler></at>"));
  assert.ok(serialized.includes("<at id=ou_dev></at>"));
  assert.match(serialized, /请相关人员尽快推进，并及时更新状态和进展/);
  assert.match(serialized, /https:\/\/requirements\.example\.test\/app\/requirements\/rec_req/);
});

test("状态通知卡片只在顶部 Header 保留主题色", () => {
  const previous = snapshot({ status: "开发中" });
  const next = snapshot({ status: "测试中" });
  const plans = buildRequirementNotificationPlan({
    config,
    requirement: requirement(next),
    previous,
    next,
    changes: [{ key: "status", label: "状态", before: "开发中", after: "测试中" }],
    iterationNames: ["工作流测试"]
  });
  const group = plans.find((item) => item.kind === "status-group");
  assert.equal(group.card.header.template, "wathet");
  assert.equal(group.card.header.text_tag_list[0].color, "wathet");
  const body = JSON.stringify(group.card.body);
  assert.doesNotMatch(body, /background_style/);
  assert.doesNotMatch(body, /<font color=/);
  assert.match(body, /开发中 → 测试中/);
  assert.equal(group.card.body.elements.at(-1).type, "primary_filled");
  assert.equal(group.card.body.elements.at(-1).size, "small");
  assert.equal(group.card.body.padding, "8px 12px 12px 12px");
  assert.equal(group.card.body.vertical_spacing, "8px");
  assert.equal(group.card.config.style.text_size.title.default, "heading-4");
  assert.ok(group.card.body.elements
    .filter((item) => item.tag === "column_set")
    .every((item) => item.columns.every((column) => column.padding === "4px 8px")));
  assert.equal(validateNotificationCard(group.card), true);
});

test("新处理人与状态同时变化时私聊合并为一张工作卡片", () => {
  const previous = snapshot({ handlers: [], status: "已评审" });
  const next = snapshot({ status: "开发中" });
  const plans = buildRequirementNotificationPlan({
    config,
    requirement: requirement(next),
    previous,
    next,
    changes: [
      { key: "handlers", label: "当前处理人", before: [], after: next.handlers },
      { key: "status", label: "状态", before: "已评审", after: "开发中" }
    ],
    iterationNames: ["S1"]
  });
  const direct = plans.filter((item) => item.channel === "user");
  assert.equal(direct.length, 1);
  assert.equal(direct[0].targetId, "ou_handler");
  assert.equal(direct[0].kind, "assignment");
});

test("普通字段变更不会生成需求群或迭代群通知", () => {
  const previous = snapshot({ priority: "P2" });
  const next = snapshot({ priority: "P1" });
  const plans = buildRequirementNotificationPlan({
    config,
    requirement: requirement(next),
    previous,
    next,
    changes: [{ key: "priority", label: "优先级", before: "P2", after: "P1" }],
    iterationNames: ["S1"]
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].channel, "user");
  assert.equal(plans[0].targetId, "ou_handler");
});


test("工单卡片不显示迭代和研发角色，也不广播问题正文", () => {
  const previous=snapshot({type:"工单",status:"处理中"});
  const next=snapshot({type:"工单",status:"已解决",latestProgress:"private detailed resolution"});
  const plans=buildRequirementNotificationPlan({config, requirement:requirement(next), previous, next, iterationNames:["stale iteration"], changes:[{key:"status",label:"状态",before:"处理中",after:"已解决"},{key:"latestProgress",label:"最新进展",before:"",after:next.latestProgress}]});
  assert.equal(plans.length,2);
  for(const plan of plans){const text=JSON.stringify(plan.card);assert.match(text,/工单/);assert.match(text,/查看工单/);assert.doesNotMatch(text,/所属迭代|stale iteration|研发人员|测试人员|private detailed resolution|尽快推进/);validateNotificationCard(plan.card);}
});
test("工单的历史研发人员和迭代变更不会通知", () => {
  const previous=snapshot({type:"工单",developers:[]}),next=snapshot({type:"工单"});
  const plans=buildRequirementNotificationPlan({config,requirement:requirement(next),previous,next,iterationNames:[],changes:[{key:"developers",label:"研发人员",before:[],after:next.developers}]});assert.deepEqual(plans,[]);
});


test("工单分派同时通知新处理人和工单群",()=>{
 const previous=snapshot({type:"工单",handlers:[]}),next=snapshot({type:"工单"});
 const plans=buildRequirementNotificationPlan({config,requirement:requirement(next),previous,next,iterationNames:[],changes:[{key:"handlers",label:"当前处理人",before:[],after:next.handlers}]});
 assert.equal(plans.filter(p=>p.channel==="chat").length,1);assert.equal(plans.filter(p=>p.channel==="user").length,1);assert.doesNotMatch(JSON.stringify(plans),/所属迭代|研发人员/);
});
