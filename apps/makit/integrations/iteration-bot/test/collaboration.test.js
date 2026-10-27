import test from "node:test";
import assert from "node:assert/strict";
import {
  createCollaborationController,
  groupName,
  createRequirementGroup,
  deterministicGroupUuid,
  diffRequirementSnapshots,
  formatRequirementNotification,
  REQUIREMENT_SNAPSHOT_VERSION,
  requirementFingerprint,
  requirementSnapshot
} from "../src/collaboration.js";

const config = {
  baseToken: "base_test",
  baseUrl: "https://example.test/base/base_test",
  requirementPlatformUrl: "https://requirements.example.test/app",
  tables: { requirements: "tbl_req" },
  identities: { messages: "bot" },
  authorization: { ownerOpenIds: ["ou_owner"] },
  runtime: {
    timezone: "Asia/Shanghai",
    collaborationMaxAttempts: 3,
    collaborationRetryBaseSeconds: 10
  }
};

function requirement(overrides = {}) {
  return {
    recordId: "rec_req",
    title: "网关支持新模型",
    iterationIds: ["rec_iter"],
    status: "开发中",
    priority: "P1",
    project: "AI 网关",
    introduction: "## 背景\n\n支持新模型接入。",
    handlers: [{ id: "ou_handler", name: "处理人" }],
    productOwners: [{ id: "ou_product", name: "产品" }],
    developers: [{ id: "ou_dev", name: "研发" }],
    testers: [{ id: "ou_test", name: "测试" }],
    blocked: false,
    blocker: "",
    latestProgress: "开发中",
    ...overrides
  };
}

test("需求快照指纹稳定且只报告重要字段变化", () => {
  const first = requirementSnapshot(requirement());
  const reordered = requirementSnapshot(requirement({
    developers: [{ id: "ou_dev", name: "研发" }]
  }));
  assert.equal(requirementFingerprint(first), requirementFingerprint(reordered));

  const next = { ...first, status: "测试中", latestProgress: "已提测" };
  assert.deepEqual(
    diffRequirementSnapshots(first, next).map((item) => item.label),
    ["状态", "最新进展"]
  );
});

test("旧版快照缺失的新字段只建立基线，不产生未设置到未设置的伪变更", () => {
  const current = requirementSnapshot(requirement({
    code: "REQ-100",
    type: "",
    source: "",
    tags: [],
    proposers: [],
    followers: [],
    releaseOwners: [],
    actualStart: null,
    actualTest: null,
    actualRelease: null,
    effort: null
  }));
  const legacy = structuredClone(current);
  for (const key of [
    "code",
    "type",
    "source",
    "tags",
    "proposers",
    "followers",
    "releaseOwners",
    "actualStart",
    "actualTest",
    "actualRelease",
    "effort"
  ]) {
    delete legacy[key];
  }

  assert.deepEqual(diffRequirementSnapshots(legacy, current), []);
  assert.deepEqual(
    diffRequirementSnapshots(legacy, { ...current, status: "测试中" })
      .map((item) => item.label),
    ["状态"]
  );
});

test("首次见到新需求时只报告有业务值的字段", () => {
  const current = requirementSnapshot(requirement({
    code: "REQ-101",
    type: "",
    source: "",
    tags: [],
    proposers: [],
    followers: [],
    releaseOwners: [],
    actualStart: null,
    actualTest: null,
    actualRelease: null,
    effort: null,
    blocked: false,
    blocker: "",
    latestProgress: ""
  }));
  const labels = diffRequirementSnapshots(null, current).map((item) => item.label);

  assert.ok(labels.includes("需求编号"));
  assert.ok(labels.includes("需求名称"));
  assert.ok(labels.includes("当前处理人"));
  assert.ok(!labels.includes("需求类型"));
  assert.ok(!labels.includes("需求来源"));
  assert.ok(!labels.includes("需求标签"));
  assert.ok(!labels.includes("实际开始时间"));
  assert.ok(!labels.includes("实际提测时间"));
  assert.ok(!labels.includes("实际发布时间"));
  assert.ok(!labels.includes("工作量"));
});

test("需求群 UUID 对同一需求稳定且格式合法", () => {
  const first = deterministicGroupUuid("rec_req");
  assert.equal(first, deterministicGroupUuid("rec_req"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("需求通知包含直达链接、真实 at 和正式收尾", () => {
  const markdown = formatRequirementNotification({
    config,
    type: "需求变更",
    requirement: requirement(),
    iterationNames: ["S1"],
    changes: [{ label: "状态", before: "开发中", after: "测试中" }]
  });
  assert.match(markdown, /https:\/\/requirements\.example\.test\/app\/requirements\/rec_req/);
  assert.match(markdown, /<at user_id="ou_handler">处理人<\/at>/);
  assert.match(markdown, /状态 开发中 → 测试中/);
  assert.match(markdown, /请相关人员尽快推进，并及时更新状态和进展/);
});

test("需求介绍变更通知只展示填写状态和字数", () => {
  const markdown = formatRequirementNotification({
    config,
    type: "需求变更",
    requirement: requirement(),
    iterationNames: ["S1"],
    changes: [{
      key: "introduction",
      label: "需求介绍",
      before: "",
      after: "## 目标\n\n不在群通知中展开全部内容。"
    }]
  });
  assert.match(markdown, /需求介绍 未填写 → 已填写（\d+ 字）/);
  assert.doesNotMatch(markdown, /不在群通知中展开全部内容/);
});

test("创建需求群使用幂等 UUID、完整成员并回写链接", async () => {
  const calls = [];
  const writes = [];
  const sent = [];
  const base = {
    valueText: (value) => String(value || ""),
    getIterationById: async () => ({ fields: { "迭代名称": "S1" } }),
    updateRequirement: async (_recordId, fields) => writes.push(fields)
  };
  const cli = {
    async json(args) {
      calls.push(args);
      if (args[1] === "chats" && args[2] === "create") return { data: { chat_id: "oc_group" } };
      if (args[1] === "chats" && args[2] === "link") {
        return { data: { share_link: "https://example.test/group" } };
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    }
  };
  const result = await createRequirementGroup({
    config,
    base,
    cli,
    requirement: requirement(),
    sendMarkdown: async (...args) => sent.push(args),
    now: new Date("2026-08-01T00:00:00Z")
  });
  assert.equal(result.created, true);
  assert.equal(result.chatId, "oc_group");
  const createCall = calls.find((args) => args[1] === "chats" && args[2] === "create");
  assert.equal(createCall[createCall.indexOf("--uuid") + 1], deterministicGroupUuid("rec_req"));
  const payload = JSON.parse(createCall[createCall.indexOf("--data") + 1]);
  assert.deepEqual(
    new Set(payload.user_id_list),
    new Set(["ou_owner", "ou_handler", "ou_product", "ou_dev", "ou_test"])
  );
  assert.equal(payload.owner_id, "ou_owner");
  assert.ok(createCall.includes("--set-bot-manager"));
  assert.ok(writes.some((fields) => fields["需求群ID"] === "oc_group"));
  assert.ok(writes.some((fields) => fields["需求群链接"]?.link === "https://example.test/group"));
  assert.match(sent[0][1], /https:\/\/requirements\.example\.test\/app\/requirements\/rec_req/);
});

test("需求群建立后首条消息失败不回写失败状态", async () => {
  const writes = [];
  const base = {
    valueText: (value) => String(value || ""),
    getIterationById: async () => ({ fields: { "迭代名称": "S1" } }),
    updateRequirement: async (_recordId, fields) => writes.push(fields)
  };
  const cli = {
    async json(args) {
      if (args[1] === "chats" && args[2] === "create") {
        return { data: { chat_id: "oc_group" } };
      }
      if (args[1] === "chats" && args[2] === "link") {
        throw new Error("link unavailable");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    }
  };

  const result = await createRequirementGroup({
    config,
    base,
    cli,
    requirement: requirement(),
    sendMarkdown: async () => {
      throw new Error("message unavailable");
    }
  });

  assert.equal(result.created, true);
  assert.ok(writes.some((fields) => fields["需求群ID"] === "oc_group"));
  assert.ok(writes.some((fields) => fields["拉群状态"] === "已创建"));
  assert.ok(!writes.some((fields) => fields["拉群状态"] === "失败"));
});

test("来源待确认只保留该需求基线，不阻塞其他需求，也不重复其事件", async () => {
  const priorFlag = process.env.WORKFLOW_EVENT_SOURCE;
  process.env.WORKFLOW_EVENT_SOURCE = 'confirmed_operations_v1';
  try {
    let current = [requirement({recordId:'recA'}),requirement({recordId:'recB'})];
    let baseline = false, snapshots = {};
    const created = [];
    const state = {
      isCollaborationBaselineReady:()=>baseline,
      markCollaborationBaselineReady:async()=>{baseline=true;},
      replaceRequirementSnapshots:async(next)=>{snapshots=structuredClone(next);},
      listRequirementSnapshots:()=>structuredClone(snapshots),
      getRequirementSnapshot:(id)=>structuredClone(snapshots[id] || null),
    };
    const controller = createCollaborationController({config,state,cli:{},sendMarkdown:async()=>{},
      base:{listAllRequirements:async()=>current,createCollaborationEvent:async(key,fields)=>{created.push({key,fields});return {recordId:'recEvent',eventKey:key,fields};}},
      reconcileWorkflow:async(id)=>{if(id==='recA') throw new Error('receipt not yet confirmed'); return [];},
    });
    await controller.scanRequirements();
    current = current.map((row)=>({...row,status:'测试中'}));
    await assert.rejects(controller.scanRequirements(), /deferred for 1/);
    assert.equal(snapshots.recA.status,'开发中');
    assert.equal(snapshots.recB.status,'测试中');
    assert.equal(created.length,1);
    await assert.rejects(controller.scanRequirements(), /deferred for 1/);
    assert.equal(created.length,1);
  } finally {
    if (priorFlag === undefined) delete process.env.WORKFLOW_EVENT_SOURCE;
    else process.env.WORKFLOW_EVENT_SOURCE = priorFlag;
  }
});

test("首次扫描只建立基线，后续变化生成一个幂等事件", async () => {
  let current = requirement();
  const created = [];
  const snapshots = {};
  let baseline = false;
  const base = {
    listAllRequirements: async () => [current],
    getIterationById: async () => ({ recordId: "rec_iter", fields: { "迭代名称": "S1" } }),
    listBindingsForIteration: async () => [{ fields: { "群聊ID": "oc_iteration" } }],
    valueText: (value) => String(value || ""),
    createCollaborationEvent: async (key, fields) => {
      created.push({ key, fields });
      return { recordId: "rec_event", eventKey: key, fields };
    },
    listCollaborationEvents: async () => []
  };
  const state = {
    isCollaborationBaselineReady: () => baseline,
    replaceRequirementSnapshots: async (next) => {
      for (const key of Object.keys(snapshots)) delete snapshots[key];
      Object.assign(snapshots, structuredClone(next));
    },
    markCollaborationBaselineReady: async () => { baseline = true; },
    getRequirementSnapshot: (id) => structuredClone(snapshots[id] || null),
    setRequirementSnapshot: async (id, value) => { snapshots[id] = structuredClone(value); },
    listRequirementSnapshots: () => structuredClone(snapshots)
  };
  const controller = createCollaborationController({
    config,
    base,
    state,
    cli: {},
    sendMarkdown: async () => {}
  });
  const first = await controller.scanRequirements();
  assert.equal(first.baseline, true);
  assert.equal(created.length, 0);

  current = requirement({ status: "测试中" });
  const second = await controller.scanRequirements();
  assert.equal(second.events, 1);
  assert.equal(created[0].fields["事件类型"], "需求变更");
  assert.deepEqual(created[0].fields["目标群"], []);

  current = requirement({
    status: "测试中",
    iterationIds: ["rec_iter", "rec_iter2"],
    updatedAt: "2026-08-01 10:00:00"
  });
  const third = await controller.scanRequirements();
  assert.equal(third.events, 2);
  assert.equal(created[1].fields["事件类型"], "需求变更");
  assert.deepEqual(created[1].fields["目标群"], []);
  assert.equal(created[2].fields["事件类型"], "需求新增");
  assert.deepEqual(created[2].fields["迭代"], [{ id: "rec_iter2" }]);
  assert.deepEqual(created[2].fields["目标群"], [{ id: "oc_iteration" }]);

  current = requirement({
    status: "测试中",
    iterationIds: ["rec_iter"],
    updatedAt: "2026-08-01 10:01:00"
  });
  assert.equal((await controller.scanRequirements()).events, 1);

  current = requirement({
    status: "测试中",
    iterationIds: ["rec_iter", "rec_iter2"],
    updatedAt: "2026-08-01 10:02:00"
  });
  assert.equal((await controller.scanRequirements()).events, 2);
  assert.notEqual(created[1].key, created[4].key);
  assert.notEqual(created[2].key, created[5].key);
});

test("快照结构升级时重建基线且不发送历史需求通知", async () => {
  const current = requirement({
    code: "REQ-100",
    updatedAt: "2026-08-01 10:00:00"
  });
  const created = [];
  let snapshots = {
    rec_req: {
      title: current.title,
      iterationIds: current.iterationIds,
      status: current.status,
      priority: current.priority,
      project: current.project,
      handlers: current.handlers
    }
  };
  let version = 0;
  const state = {
    isCollaborationBaselineReady: () => true,
    getCollaborationSnapshotVersion: () => version,
    setCollaborationSnapshotVersion: async (next) => { version = next; },
    listRequirementSnapshots: () => structuredClone(snapshots),
    getRequirementSnapshot: (id) => structuredClone(snapshots[id] || null),
    replaceRequirementSnapshots: async (next) => { snapshots = structuredClone(next); },
    markCollaborationBaselineReady: async () => {}
  };
  const controller = createCollaborationController({
    config,
    base: {
      listAllRequirements: async () => [current],
      createCollaborationEvent: async (...args) => created.push(args)
    },
    state,
    cli: {},
    sendMarkdown: async () => {},
    now: () => new Date("2026-08-01T10:01:00+08:00")
  });

  const result = await controller.scanRequirements();
  assert.equal(result.baseline, true);
  assert.match(result.reason, /snapshot-schema/);
  assert.equal(result.events, 0);
  assert.equal(created.length, 0);
  assert.equal(version, REQUIREMENT_SNAPSHOT_VERSION);
  assert.equal(snapshots.rec_req.code, "REQ-100");
});

test("基线标记存在但快照整体丢失时只恢复基线", async () => {
  const current = requirement({
    code: "REQ-100",
    updatedAt: "2026-08-01 10:00:00"
  });
  let snapshots = {};
  const created = [];
  const state = {
    isCollaborationBaselineReady: () => true,
    getCollaborationSnapshotVersion: () => REQUIREMENT_SNAPSHOT_VERSION,
    setCollaborationSnapshotVersion: async () => {},
    listRequirementSnapshots: () => structuredClone(snapshots),
    getRequirementSnapshot: (id) => structuredClone(snapshots[id] || null),
    replaceRequirementSnapshots: async (next) => { snapshots = structuredClone(next); },
    markCollaborationBaselineReady: async () => {}
  };
  const controller = createCollaborationController({
    config,
    base: {
      listAllRequirements: async () => [current],
      createCollaborationEvent: async (...args) => created.push(args)
    },
    state,
    cli: {},
    sendMarkdown: async () => {},
    now: () => new Date("2026-08-01T10:01:00+08:00")
  });

  const result = await controller.scanRequirements();
  assert.equal(result.baseline, true);
  assert.equal(result.reason, "snapshot-store-empty");
  assert.equal(result.events, 0);
  assert.equal(created.length, 0);
  assert.equal(Object.keys(snapshots).length, 1);
});

test("130 条旧版快照同时升级不会生成批量误提醒", async () => {
  const requirements = Array.from({ length: 130 }, (_value, index) => requirement({
    recordId: `rec_req_${index}`,
    code: `REQ-${String(index + 1).padStart(3, "0")}`,
    updatedAt: "2026-07-01 10:00:00"
  }));
  let snapshots = Object.fromEntries(requirements.map((item) => {
    const legacy = requirementSnapshot(item);
    for (const key of [
      "code",
      "type",
      "source",
      "tags",
      "proposers",
      "followers",
      "releaseOwners",
      "actualStart",
      "actualTest",
      "actualRelease",
      "effort"
    ]) {
      delete legacy[key];
    }
    return [item.recordId, legacy];
  }));
  const created = [];
  const state = {
    isCollaborationBaselineReady: () => true,
    getCollaborationSnapshotVersion: () => REQUIREMENT_SNAPSHOT_VERSION,
    listRequirementSnapshots: () => structuredClone(snapshots),
    getRequirementSnapshot: (id) => structuredClone(snapshots[id] || null),
    replaceRequirementSnapshots: async (next) => { snapshots = structuredClone(next); },
    markCollaborationBaselineReady: async () => {}
  };
  const controller = createCollaborationController({
    config,
    base: {
      listAllRequirements: async () => requirements,
      createCollaborationEvent: async (...args) => created.push(args)
    },
    state,
    cli: {},
    sendMarkdown: async () => {},
    now: () => new Date("2026-08-01T10:01:00+08:00")
  });

  const result = await controller.scanRequirements();
  assert.equal(result.events, 0);
  assert.equal(created.length, 0);
  assert.equal(Object.keys(snapshots).length, 130);
  assert.equal(snapshots.rec_req_0.code, "REQ-001");
});

test("大量真实字段变化会整批隔离且不会生成逐条通知事件", async () => {
  const requirements = Array.from({ length: 25 }, (_value, index) => requirement({
    recordId: `rec_changed_${index}`,
    code: `REQ-C-${index}`,
    status: "测试中",
    updatedAt: "2026-08-01 10:00:00"
  }));
  let snapshots = Object.fromEntries(requirements.map((item) => [
    item.recordId,
    requirementSnapshot({ ...item, status: "开发中" })
  ]));
  const created = [];
  const state = {
    isCollaborationBaselineReady: () => true,
    getCollaborationSnapshotVersion: () => REQUIREMENT_SNAPSHOT_VERSION,
    listRequirementSnapshots: () => structuredClone(snapshots),
    getRequirementSnapshot: (id) => structuredClone(snapshots[id] || null),
    replaceRequirementSnapshots: async (next) => { snapshots = structuredClone(next); },
    markCollaborationBaselineReady: async () => {}
  };
  const controller = createCollaborationController({
    config,
    base: {
      listAllRequirements: async () => requirements,
      createCollaborationEvent: async (key, fields) => {
        created.push({ key, fields });
        return { recordId: "rec_incident", eventKey: key, fields };
      }
    },
    state,
    cli: {},
    sendMarkdown: async () => {},
    now: () => new Date("2026-08-01T10:01:00+08:00")
  });

  const result = await controller.scanRequirements();
  assert.equal(result.quarantined, true);
  assert.equal(result.events, 0);
  assert.equal(result.changedRequirements, 25);
  assert.equal(created.length, 1);
  assert.equal(created[0].fields["事件类型"], "安全隔离");
  assert.equal(created[0].fields["状态"], "已忽略");
  assert.equal(snapshots.rec_changed_0.status, "测试中");
});

test("空白 Base 行不会进入快照或触发通知", async () => {
  const valid = requirement({
    recordId: "rec_valid",
    updatedAt: "2026-08-01 10:00:00"
  });
  const blank = requirement({
    recordId: "rec_blank",
    title: "未命名需求",
    updatedAt: "2026-08-01 10:00:00"
  });
  let snapshots = {
    rec_valid: requirementSnapshot(valid)
  };
  const created = [];
  const state = {
    isCollaborationBaselineReady: () => true,
    getCollaborationSnapshotVersion: () => REQUIREMENT_SNAPSHOT_VERSION,
    listRequirementSnapshots: () => structuredClone(snapshots),
    getRequirementSnapshot: (id) => structuredClone(snapshots[id] || null),
    replaceRequirementSnapshots: async (next) => { snapshots = structuredClone(next); },
    markCollaborationBaselineReady: async () => {}
  };
  const controller = createCollaborationController({
    config,
    base: {
      listAllRequirements: async () => [valid, blank],
      createCollaborationEvent: async (...args) => created.push(args)
    },
    state,
    cli: {},
    sendMarkdown: async () => {},
    now: () => new Date("2026-08-01T10:01:00+08:00")
  });

  const result = await controller.scanRequirements();
  assert.equal(result.events, 0);
  assert.equal(created.length, 0);
  assert.deepEqual(Object.keys(snapshots), ["rec_valid"]);
});

for (const updatedAt of ["2026-08-01T02:00:00.000Z", Date.parse("2026-08-01T02:00:00.000Z"), String(Date.parse("2026-08-01T02:00:00.000Z"))]) test(`服务离线期间创建的新需求恢复后仍会正常通知 (${typeof updatedAt})`, async () => {
  const existing = requirement({
    recordId: "rec_existing",
    updatedAt: "2026-08-01 09:30:00"
  });
  const added = requirement({
    recordId: "rec_added",
    code: "REQ-NEW",
    updatedAt
  });
  let snapshots = {
    rec_existing: requirementSnapshot(existing)
  };
  let lastScanAt = "2026-08-01T01:59:00.000Z";
  const created = [];
  const state = {
    isCollaborationBaselineReady: () => true,
    getCollaborationSnapshotVersion: () => REQUIREMENT_SNAPSHOT_VERSION,
    getCollaborationLastScanAt: () => lastScanAt,
    setCollaborationLastScanAt: async (value) => { lastScanAt = value; },
    listRequirementSnapshots: () => structuredClone(snapshots),
    getRequirementSnapshot: (id) => structuredClone(snapshots[id] || null),
    replaceRequirementSnapshots: async (next) => { snapshots = structuredClone(next); },
    markCollaborationBaselineReady: async () => {}
  };
  const controller = createCollaborationController({
    config,
    base: {
      listAllRequirements: async () => [existing, added],
      getIterationById: async () => ({
        recordId: "rec_iter",
        fields: { "迭代名称": "S1" }
      }),
      listBindingsForIteration: async () => [{
        fields: { "群聊ID": "oc_iteration" }
      }],
      valueText: (value) => String(value || ""),
      createCollaborationEvent: async (key, fields) => {
        created.push({ key, fields });
        return { recordId: `rec_event_${created.length}`, eventKey: key, fields };
      }
    },
    state,
    cli: {},
    sendMarkdown: async () => {},
    now: () => new Date("2026-08-01T10:01:00+08:00")
  });

  const result = await controller.scanRequirements();
  assert.equal(result.events, 2);
  assert.deepEqual(
    created.map((item) => item.fields["事件类型"]),
    ["需求变更", "需求新增"]
  );
  assert.deepEqual(created[1].fields["目标群"], [{ id: "oc_iteration" }]);
  assert.equal(Object.keys(snapshots).length, 2);
  assert.equal(lastScanAt, "2026-08-01T02:01:00.000Z");
});

test("事件发送失败会回写失败状态和下次重试时间", async () => {
  const updates = [];
  const base = {
    getRequirementById: async () => requirement(),
    getIterationById: async () => ({ recordId: "rec_iter", fields: { "迭代名称": "S1" } }),
    listBindingsForIteration: async () => [{ fields: { "群聊ID": "oc_iteration" } }],
    valueText: (value) => String(value || ""),
    updateCollaborationEvent: async (_id, fields) => updates.push(fields)
  };
  const controller = createCollaborationController({
    config,
    base,
    state: {},
    cli: {},
    sendMarkdown: async () => {},
    sendCard: async () => { throw new Error("send failed"); },
    now: () => new Date("2026-08-01T00:00:00Z")
  });
  const before = requirementSnapshot(requirement());
  const after = requirementSnapshot(requirement({ status: "测试中" }));
  await assert.rejects(
    controller.processEvent({
      recordId: "rec_event",
      eventKey: "event-key",
      type: "需求变更",
      requirementIds: ["rec_req"],
      status: "待处理",
      attempts: 0,
      fields: {
        "变更前": JSON.stringify(before),
        "变更后": JSON.stringify(after)
      }
    }),
    /send failed/
  );
  assert.ok(updates.some((fields) => fields["状态"] === "处理中"));
  const failed = updates.find((fields) => fields["状态"] === "失败");
  assert.match(failed["错误信息"], /user:ou_handler send failed/);
  assert.ok(failed["下次重试时间"]);
});

test("普通需求字段变化只私聊当前处理人且不发送迭代群消息", async () => {
  const cards = [];
  const markdown = [];
  const base = {
    getRequirementById: async () => requirement({ priority: "P1" }),
    getIterationById: async () => ({ recordId: "rec_iter", fields: { "迭代名称": "S1" } }),
    valueText: (value) => String(value || ""),
    updateRequirement: async () => {},
    updateCollaborationEvent: async () => {}
  };
  const before = requirementSnapshot(requirement({ priority: "P2" }));
  const after = requirementSnapshot(requirement({ priority: "P1" }));
  const controller = createCollaborationController({
    config,
    base,
    state: {},
    cli: {},
    sendMarkdown: async (...args) => markdown.push(args),
    sendCard: async (...args) => cards.push(args),
    now: () => new Date("2026-08-01T00:00:00Z")
  });
  const result = await controller.processEvent({
    recordId: "rec_event",
    eventKey: "event-key",
    type: "需求变更",
    requirementIds: ["rec_req"],
    status: "待处理",
    attempts: 0,
    fields: {
      "变更前": JSON.stringify(before),
      "变更后": JSON.stringify(after)
    }
  });
  assert.equal(result.userCount, 1);
  assert.equal(result.chatCount, 0);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0][0], { userId: "ou_handler" });
  assert.equal(markdown.length, 0);
});

test("所属迭代变更使用迭代名称而不是关联记录 ID", async () => {
  const cards = [];
  const base = {
    getRequirementById: async () => requirement({ iterationIds: [] }),
    getIterationById: async (recordId) => recordId === "rec_iter"
      ? { recordId, fields: { "迭代名称": "工作流测试" } }
      : null,
    valueText: (value) => String(value || ""),
    updateRequirement: async () => {},
    updateCollaborationEvent: async () => {}
  };
  const before = requirementSnapshot(requirement({ iterationIds: ["rec_iter"] }));
  const after = requirementSnapshot(requirement({ iterationIds: [] }));
  const controller = createCollaborationController({
    config,
    base,
    state: {},
    cli: {},
    sendMarkdown: async () => {},
    sendCard: async (...args) => cards.push(args),
    now: () => new Date("2026-08-01T00:00:00Z")
  });

  const result = await controller.processEvent({
    recordId: "rec_event",
    eventKey: "iteration-unlink-event",
    type: "需求变更",
    requirementIds: ["rec_req"],
    status: "待处理",
    attempts: 0,
    fields: {
      "变更前": JSON.stringify(before),
      "变更后": JSON.stringify(after)
    }
  });

  assert.equal(result.userCount, 1);
  assert.equal(cards.length, 1);
  const serialized = JSON.stringify(cards[0][1]);
  assert.match(serialized, /工作流测试 → 未设置/);
  assert.doesNotMatch(serialized, /rec_iter/);
});

test("工单建群名称包含实际优先级，普通需求命名保持不变", () => {
  assert.equal(groupName('旧迭代','导出图片缺失','工单','P2'),'【P2工单】导出图片缺失');
  assert.equal(groupName('S1','新功能'),'【S1】新功能');
  assert.equal(groupName('','新功能'),'【需求】新功能');
  assert.equal(groupName('','', '工单',''),'【未定级工单】未命名工单');
  const name=groupName('', '😀'.repeat(80), '工单', 'P0');
  assert.ok(name.length<=60);assert.ok(name.endsWith('😀'));
});
