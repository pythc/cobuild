import { createHash, randomUUID } from "node:crypto";
import { requirementRecordUrl } from "./response-policy.js";
import { buildRequirementNotificationPlan } from "./requirement-notifications.js";
import { confirmedSourceEnabled, nativeWorkflowSegments } from './workflow-source.js';

export const REQUIREMENT_SNAPSHOT_VERSION = 1;

const IMPORTANT_FIELDS = [
  ["code", "需求编号"],
  ["title", "需求名称"],
  ["type", "需求类型"],
  ["source", "需求来源"],
  ["tags", "需求标签"],
  ["introduction", "需求介绍"],
  ["acceptanceCriteria", "验收标准"],
  ["selfTestReport", "自测报告"],
  ["iterationIds", "所属迭代"],
  ["status", "状态"],
  ["priority", "优先级"],
  ["project", "项目"],
  ["proposers", "提出人"],
  ["handlers", "当前处理人"],
  ["productOwners", "产品人员"],
  ["developers", "研发人员"],
  ["testers", "测试人员"],
  ["foOwners", "FO"],
  ["followers", "关注人"],
  ["releaseOwners", "发布负责人"],
  ["deadline", "截止时间"],
  ["actualStart", "实际开始时间"],
  ["actualTest", "实际提测时间"],
  ["actualRelease", "实际发布时间"],
  ["effort", "开发工作量"],
  ["blocked", "是否阻塞"],
  ["blocker", "阻塞原因"],
  ["latestProgress", "最新进展"]
];

function dateTimeText(date, timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function normalizePeople(items = []) {
  return items
    .filter((item) => item?.id)
    .map((item) => ({ id: item.id, name: item.name || "" }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function uniquePeople(groups) {
  const result = [];
  const seen = new Set();
  for (const person of groups.flat()) {
    if (!person?.id || seen.has(person.id)) continue;
    seen.add(person.id);
    result.push({ id: person.id, name: person.name || "" });
  }
  return result;
}

function mentionList(items) {
  if (!items.length) return "未分配处理人";
  return items.map((item) => `<at user_id="${item.id}">${item.name || ""}</at>`).join("、");
}

function displayValue(value) {
  if (Array.isArray(value)) {
    if (!value.length) return "未设置";
    if (typeof value[0] === "object") {
      return value.map((item) => item.name || item.id).filter(Boolean).join("、") || "未设置";
    }
    return value.join("、") || "未设置";
  }
  if (value === true) return "是";
  if (value === false) return "否";
  return value == null || value === "" ? "未设置" : String(value);
}

function displayChange(change) {
  if (!["introduction", "acceptanceCriteria", "selfTestReport"].includes(change.key)) {
    const before = Object.hasOwn(change, "beforeDisplay")
      ? change.beforeDisplay
      : displayValue(change.before);
    const after = Object.hasOwn(change, "afterDisplay")
      ? change.afterDisplay
      : displayValue(change.after);
    return `${change.label} ${before} → ${after}`;
  }
  const beforeLength = String(change.before || "").length;
  const afterLength = String(change.after || "").length;
  const before = beforeLength ? `已填写（${beforeLength} 字）` : "未填写";
  const after = afterLength ? `已填写（${afterLength} 字）` : "未填写";
  return `${change.label} ${before} → ${after}`;
}

function responseData(response) {
  return response?.data?.data || response?.data || response || {};
}

export function groupName(iterationName, requirementTitle, type = '', priority = '') {
  const ticket = type === '工单';
  const level = /^P[0-3]$/.test(priority) ? priority : '未定级';
  const prefix = ticket ? `【${level}工单】` : iterationName ? `【${iterationName}】` : '【需求】';
  let name = prefix;
  for (const character of String(requirementTitle || (ticket ? '未命名工单' : '未命名需求'))) {
    if (name.length + character.length > 60) break;
    name += character;
  }
  return name;
}

function desiredPeople(config, requirement) {
  const owners = (config.authorization?.ownerOpenIds || []).map((id) => ({ id, name: "" }));
  return uniquePeople([
    owners,
    requirement.handlers || [],
    requirement.productOwners || [],
    requirement.developers || [],
    requirement.testers || [],
    requirement.proposers || [],
    requirement.followers || [],
    requirement.releaseOwners || []
  ]);
}

function extractMemberIds(response) {
  const data = responseData(response);
  const candidates = [
    data.items,
    data.member_list,
    data.members,
    data.data?.items,
    data.data?.member_list
  ].find(Array.isArray) || [];
  return candidates
    .map((item) => item?.member_id || item?.id || item?.open_id || "")
    .filter(Boolean);
}

export function requirementSnapshot(requirement) {
  return {
    notificationMarker: requirement.notificationMarker || '',
    code: requirement.code || "",
    title: requirement.title || "",
    type: requirement.type || "",
    source: requirement.source || "",
    tags: [...(requirement.tags || [])].sort(),
    introduction: requirement.introduction || "",
    acceptanceCriteria: requirement.acceptanceCriteria || "",
    selfTestReport: requirement.selfTestReport || "",
    iterationIds: [...(requirement.iterationIds || [])].sort(),
    status: requirement.status || "",
    priority: requirement.priority || "",
    project: requirement.project || "",
    handlers: normalizePeople(requirement.handlers),
    productOwners: normalizePeople(requirement.productOwners),
    developers: normalizePeople(requirement.developers),
    testers: normalizePeople(requirement.testers),
    foOwners: normalizePeople(requirement.foOwners),
    proposers: normalizePeople(requirement.proposers),
    followers: normalizePeople(requirement.followers),
    releaseOwners: normalizePeople(requirement.releaseOwners),
    startDate: requirement.startDate || null,
    deadline: requirement.deadline || null,
    developmentStart: requirement.developmentStart || null,
    developmentEnd: requirement.developmentEnd || null,
    testDate: requirement.testDate || null,
    actualStart: requirement.actualStart || null,
    actualTest: requirement.actualTest || null,
    actualRelease: requirement.actualRelease || null,
    effort: Number.isFinite(requirement.effort) ? requirement.effort : null,
    blocked: requirement.blocked === true,
    blocker: requirement.blocker || "",
    latestProgress: requirement.latestProgress || "",
    modifiedBy: requirement.modifiedBy?.id
      ? { id: requirement.modifiedBy.id, name: requirement.modifiedBy.name || "" }
      : null
  };
}

export function requirementFingerprint(snapshot) {
  const businessFields = Object.fromEntries(
    IMPORTANT_FIELDS.filter(([key])=>key!=="deadline"||snapshot?.type==="工单").map(([key]) => [key, snapshot?.[key]])
  );
  return createHash("sha256").update(JSON.stringify(businessFields)).digest("hex");
}

function comparableValue(value) {
  if (value == null || value === "" || value === "未设置") return null;
  if (value === false) return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return value.map((item) => item && typeof item === 'object' && typeof item.id === 'string' ? item.id : comparableValue(item)).sort();
  }
  if (
    typeof value === "object"
    && Number(value.__textLength || 0) === 0
    && typeof value.__fingerprint === "string"
  ) {
    return null;
  }
  return value;
}

function hasMeaningfulValue(value) {
  return comparableValue(value) !== null;
}

export function diffRequirementSnapshots(previous, next) {
  if (!previous) {
    return IMPORTANT_FIELDS
      .filter(([key]) => (key!=="deadline"||next.type==="工单")&&hasMeaningfulValue(next[key]))
      .map(([key, label]) => ({
        key,
        label,
        before: null,
        after: next[key]
      }));
  }
  const changes = [];
  for (const [key, label] of IMPORTANT_FIELDS) {
    if(key==="deadline"&&next.type!=="工单")continue;
    // A missing key means the field did not exist in the persisted snapshot
    // schema. It is not evidence that the Base field changed. The next full
    // snapshot will establish the baseline for that field.
    if (!Object.hasOwn(previous, key)) continue;
    if (
      JSON.stringify(comparableValue(previous[key]))
      === JSON.stringify(comparableValue(next[key]))
    ) {
      continue;
    }
    changes.push({ key, label, before: previous[key], after: next[key] });
  }
  return changes;
}

function compactEventSnapshot(snapshot) {
  if (!snapshot) return null;
  const compact = structuredClone(snapshot);
  compact.introduction = {
    __textLength: String(snapshot.introduction || "").length,
    __fingerprint: createHash("sha1").update(String(snapshot.introduction || "")).digest("hex")
  };
  compact.acceptanceCriteria = {
    __textLength: String(snapshot.acceptanceCriteria || "").length,
    __fingerprint: createHash("sha1")
      .update(String(snapshot.acceptanceCriteria || ""))
      .digest("hex")
  };
  compact.selfTestReport = {
    __textLength: String(snapshot.selfTestReport || "").length,
    __fingerprint: createHash("sha1")
      .update(String(snapshot.selfTestReport || ""))
      .digest("hex")
  };
  compact.title = String(snapshot.title || "").slice(0, 500);
  compact.blocker = String(snapshot.blocker || "").slice(0, 1000);
  compact.latestProgress = String(snapshot.latestProgress || "").slice(0, 1500);
  return compact;
}

function serializeEventSnapshot(snapshot) {
  const value = JSON.stringify(compactEventSnapshot(snapshot));
  if (value.length > 5000) throw new Error("需求变更快照超过协作事件字段容量");
  return value;
}

function parseEventSnapshot(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function requirementAtEvent(current, snapshot) {
  if (!snapshot) return current;
  return {
    ...current,
    code: snapshot.code ?? current.code,
    title: snapshot.title ?? current.title,
    type: snapshot.type ?? current.type,
    source: snapshot.source ?? current.source,
    tags: snapshot.tags ?? current.tags,
    introduction: snapshot.introduction ?? current.introduction,
    acceptanceCriteria: snapshot.acceptanceCriteria ?? current.acceptanceCriteria,
    selfTestReport: snapshot.selfTestReport ?? current.selfTestReport,
    iterationIds: snapshot.iterationIds ?? current.iterationIds,
    status: snapshot.status ?? current.status,
    priority: snapshot.priority ?? current.priority,
    project: snapshot.project ?? current.project,
    handlers: snapshot.handlers ?? current.handlers,
    productOwners: snapshot.productOwners ?? current.productOwners,
    developers: snapshot.developers ?? current.developers,
    testers: snapshot.testers ?? current.testers,
    proposers: snapshot.proposers ?? current.proposers,
    followers: snapshot.followers ?? current.followers,
    releaseOwners: snapshot.releaseOwners ?? current.releaseOwners,
    startDate: snapshot.startDate ?? current.startDate,
    deadline: snapshot.deadline ?? current.deadline,
    developmentStart: snapshot.developmentStart ?? current.developmentStart,
    developmentEnd: snapshot.developmentEnd ?? current.developmentEnd,
    testDate: snapshot.testDate ?? current.testDate,
    actualStart: snapshot.actualStart ?? current.actualStart,
    actualTest: snapshot.actualTest ?? current.actualTest,
    actualRelease: snapshot.actualRelease ?? current.actualRelease,
    effort: snapshot.effort ?? current.effort,
    blocked: snapshot.blocked ?? current.blocked,
    blocker: snapshot.blocker ?? current.blocker,
    latestProgress: snapshot.latestProgress ?? current.latestProgress,
    modifiedBy: snapshot.modifiedBy ?? current.modifiedBy
  };
}

function displayIterationIds(iterationIds, namesById) {
  if (!Array.isArray(iterationIds) || !iterationIds.length) return "未设置";
  return iterationIds
    .map((id) => namesById.get(id) || "未知迭代")
    .join("、");
}

async function resolveRequirementChangeContext(base, previous, next, changes) {
  const iterationIds = [...new Set([
    ...(previous?.iterationIds || []),
    ...(next?.iterationIds || [])
  ])];
  const iterations = (await Promise.all(
    iterationIds.map((id) => base.getIterationById(id))
  )).filter(Boolean);
  const namesById = new Map(iterations.map((iteration) => [
    iteration.recordId,
    base.valueText(iteration.fields["迭代名称"])
  ]));
  const iterationNames = (next?.iterationIds || [])
    .map((id) => namesById.get(id))
    .filter(Boolean);
  const displayChanges = changes.map((change) => {
    if (change.key !== "iterationIds") return change;
    return {
      ...change,
      beforeDisplay: displayIterationIds(change.before, namesById),
      afterDisplay: displayIterationIds(change.after, namesById)
    };
  });
  return { iterations, iterationNames, changes: displayChanges };
}

export function deterministicGroupUuid(recordId) {
  const hex = createHash("sha256").update(`feishu-requirement-group:${recordId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function formatRequirementNotification({
  config,
  type,
  requirement,
  iterationNames = [],
  changes = []
}) {
  const people = uniquePeople([
    requirement.handlers || [],
    requirement.productOwners || [],
    requirement.developers || [],
    requirement.testers || [],
    requirement.proposers || [],
    requirement.followers || [],
    requirement.releaseOwners || []
  ]);
  const lines = [
    `#### ${type === "需求新增" ? "新需求已纳入迭代" : "迭代需求已更新"}`,
    "",
    `- [${requirement.title}](${requirementRecordUrl(config, requirement.recordId)})`,
    `- 迭代：${iterationNames.join("、") || "未设置"} · 状态：${requirement.status} · 优先级：${requirement.priority}`
  ];
  if (type === "需求变更" && changes.length) {
    lines.push("- 变更：" + changes
      .slice(0, 6)
      .map(displayChange)
      .join("；"));
  }
  lines.push(`- 相关人员：${mentionList(people)}`);
  if (!requirement.handlers?.length) lines.push("- 当前处理人：未分配处理人");
  lines.push("", "> 请相关人员尽快推进，并及时更新状态和进展。");
  return lines.join("\n");
}

export async function syncRequirementGroup({ config, base, cli, requirement, now = new Date() }) {
  if (!requirement.groupChatId) throw new Error(`需求“${requirement.title}”尚未创建需求群`);
  const desired = desiredPeople(config, requirement);
  const listed = await cli.json([
    "im", "+chat-members-list",
    "--chat-id", requirement.groupChatId,
    "--member-types", "user",
    "--page-all",
    "--as", config.identities.messages
  ]);
  const existing = new Set(extractMemberIds(listed));
  const missing = desired.filter((item) => !existing.has(item.id));
  if (missing.length) {
    await cli.json([
      "im", "chat.members", "create",
      "--chat-id", requirement.groupChatId,
      "--member-id-type", "open_id",
      "--succeed-type", "1",
      "--data", JSON.stringify({ id_list: missing.map((item) => item.id) }),
      "--as", config.identities.messages
    ]);
  }
  await base.updateRequirement(requirement.recordId, {
    "群成员同步时间": dateTimeText(now, config.runtime.timezone),
    "拉群状态": "已创建"
  });
  return {
    chatId: requirement.groupChatId,
    groupLink: requirement.groupLink,
    addedMembers: missing
  };
}

export async function createRequirementGroup({
  config,
  base,
  cli,
  requirement,
  sendMarkdown,
  now = new Date()
}) {
  if (requirement.groupChatId) {
    const synced = await syncRequirementGroup({ config, base, cli, requirement, now });
    return { ...synced, created: false };
  }

  const iterations = await Promise.all(
    (requirement.iterationIds || []).map((id) => base.getIterationById(id))
  );
  const iterationNames = iterations
    .filter(Boolean)
    .map((item) => base.valueText(item.fields["迭代名称"]))
    .filter(Boolean);
  const members = desiredPeople(config, requirement);
  const ownerId = config.authorization?.ownerOpenIds?.[0];
  if (!ownerId) throw new Error("未配置需求群群主");

  await base.updateRequirement(requirement.recordId, {
    "拉群状态": "创建中"
  });

  try {
    const response = await cli.json([
      "im", "chats", "create",
      "--uuid", deterministicGroupUuid(requirement.recordId),
      "--user-id-type", "open_id",
      "--set-bot-manager",
      "--data", JSON.stringify({
        name: groupName(iterationNames[0], requirement.title, requirement.type, requirement.priority),
        description: `${requirement.type === "工单" ? "工单讨论群" : "需求协作群"}：${requirement.title}`,
        owner_id: ownerId,
        user_id_list: members.map((item) => item.id),
        chat_type: "private"
      }),
      "--as", config.identities.messages
    ]);
    const chatId = responseData(response).chat_id;
    if (!chatId) throw new Error("飞书创建群聊成功但未返回 chat_id");

    let shareLink = "";
    try {
      const linkResponse = await cli.json([
        "im", "chats", "link",
        "--chat-id", chatId,
        "--data", JSON.stringify({ validity_period: "permanently" }),
        "--as", config.identities.messages
      ]);
      shareLink = responseData(linkResponse).share_link || "";
    } catch {
      // 群聊本身已成功创建。分享链接失败不应让幂等重试再创建一个群。
    }

    const createdAt = dateTimeText(now, config.runtime.timezone);
    const chatLink = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
    await base.updateRequirement(requirement.recordId, {
      "需求群ID": chatId,
      "需求群链接": { link: chatLink, text: "打开需求群" },
      "拉群状态": "已创建",
      "拉群时间": createdAt,
      "群成员同步时间": createdAt
    });
    try {
      await base.updateRequirement(requirement.recordId, {
        "需求群聊": [{ id: chatId }]
      });
    } catch {
      // 群组件字段异常不影响已回写的群 ID、直链和创建状态。
    }
    if (shareLink) {
      try {
        await base.updateRequirement(requirement.recordId, {
          "需求群链接": { link: shareLink, text: "打开需求群" }
        });
      } catch {
        // 永久链接回写失败时保留已可用的会话直链。
      }
    }

    const markdown = [
      requirement.type === "工单" ? "#### 工单讨论群已建立" : "#### 需求协作群已建立",
      "",
      `- [${requirement.title}](${requirementRecordUrl(config, requirement.recordId)})`,
      requirement.type === "工单" ? `- 状态：${requirement.status} · 优先级：${requirement.priority}` : `- 迭代：${iterationNames.join("、") || "未设置"} · 状态：${requirement.status} · 优先级：${requirement.priority}`,
      `- 相关人员：${mentionList(members)}`,
      "",
      requirement.type === "工单" ? "> 请在本群讨论问题并同步处理进展，处理结果请更新到工单。" : "> 请相关人员在本群同步需求决策、进展和阻塞事项。"
    ].join("\n");
    try {
      await sendMarkdown(
        chatId,
        markdown,
        `requirement-group-${requirement.recordId}`.slice(0, 50)
      );
    } catch {
      // 首条通知失败不应将已建立的群标记为失败。
    }
    return {
      created: true,
      chatId,
      groupLink: shareLink || chatLink,
      addedMembers: members
    };
  } catch (error) {
    await base.updateRequirement(requirement.recordId, {
      "拉群状态": "失败"
    });
    throw error;
  }
}

export function createCollaborationController({
  reconcileWorkflow,
  config,
  base,
  state,
  cli,
  sendMarkdown,
  sendCard = async () => {
    throw new Error("未配置飞书卡片发送器");
  },
  log = () => {},
  now = () => new Date()
}) {
  let running = false;

  function snapshotUpdatedAfter(requirement, lastScanAt) {
    const raw = requirement.updatedAt;
    const timestamp = typeof raw === 'number' ? raw : /^\d{13}$/.test(String(raw || ''))
      ? Number(raw) : Date.parse(String(raw || "").replace(" ", "T"));
    const lastScanTimestamp = Date.parse(lastScanAt || "");
    if (!Number.isFinite(timestamp) || !Number.isFinite(lastScanTimestamp)) return false;
    // Base timestamps are second-precision while the local scan timestamp is
    // millisecond-precision. A two-second allowance avoids missing a record
    // created in the same second as the previous scan.
    return timestamp >= lastScanTimestamp - 2_000;
  }

  async function rebuildSnapshotBaseline(snapshots, reason) {
    await state.replaceRequirementSnapshots(snapshots);
    await state.markCollaborationBaselineReady();
    if (state.setCollaborationSnapshotVersion) {
      await state.setCollaborationSnapshotVersion(REQUIREMENT_SNAPSHOT_VERSION);
    }
    if (state.setCollaborationLastScanAt) {
      await state.setCollaborationLastScanAt(now().toISOString());
    }
    log(
      reason === "initial" ? "info" : "warn",
      `[collaboration] baseline rebuilt reason=${reason} requirements=${Object.keys(snapshots).length}`
    );
    return { baseline: true, reason, events: 0 };
  }

  async function enqueueChangeEvent(
    type,
    requirement,
    previous,
    snapshot,
    changes,
    eventIterationIds = snapshot.iterationIds || [],
    segmentId = ''
  ) {
    const transitionFingerprint = createHash("sha256").update(JSON.stringify({
      type,
      before: previous ? requirementFingerprint(previous) : null,
      after: requirementFingerprint(snapshot),
      iterations: [...eventIterationIds].sort(),
      occurrence: requirement.updatedAt || null,
      segmentId
    })).digest("hex");
    const eventKey = `${segmentId ? 'native-v1:' : ''}${type}:${requirement.recordId}:${transitionFingerprint}`.slice(0, 200);
    const targetChats = [];
    if (type === "需求新增") {
      for (const iterationId of eventIterationIds) {
        const iteration = await base.getIterationById(iterationId);
        if (!iteration) continue;
        const bindings = await base.listBindingsForIteration(iteration);
        targetChats.push(...bindings.map((item) => base.valueText(item.fields["群聊ID"])).filter(Boolean));
      }
    }
    await base.createCollaborationEvent(eventKey, {
      "事件类型": type,
      "需求": [{ id: requirement.recordId }],
      "迭代": eventIterationIds.map((id) => ({ id })),
      "目标群": [...new Set(targetChats)].map((id) => ({ id })),
      "状态": "待处理",
      "触发来源": "服务监听",
      "变更字段": changes.map((item) => item.label).join("、"),
      "变更前": serializeEventSnapshot(previous),
      "变更后": serializeEventSnapshot(snapshot),
      "尝试次数": 0,
      "负载摘要": `${requirement.title}：${changes.map((item) => item.label).join("、")}`.slice(0, 500)
    });
  }

  async function scanRequirements() {
    const allRequirements = await base.listAllRequirements();
    // Blank rows can be created by direct Base editing or an unfinished form.
    // They are not actionable requirements and must never notify anyone.
    const requirements = allRequirements.filter(
      (item) => item.title && item.title !== "未命名需求"
    );
    const snapshots = Object.fromEntries(
      requirements.map((item) => [item.recordId, requirementSnapshot(item)])
    );
    const previousSnapshots = state.listRequirementSnapshots
      ? state.listRequirementSnapshots()
      : {};
    const previousSnapshotCount = Object.keys(previousSnapshots).length;
    const snapshotVersion = state.getCollaborationSnapshotVersion
      ? state.getCollaborationSnapshotVersion()
      : REQUIREMENT_SNAPSHOT_VERSION;
    const lastScanAt = state.getCollaborationLastScanAt
      ? state.getCollaborationLastScanAt()
      : null;

    if (!state.isCollaborationBaselineReady()) {
      return rebuildSnapshotBaseline(snapshots, "initial");
    }
    if (snapshotVersion !== REQUIREMENT_SNAPSHOT_VERSION) {
      return rebuildSnapshotBaseline(
        snapshots,
        `snapshot-schema-${snapshotVersion}-to-${REQUIREMENT_SNAPSHOT_VERSION}`
      );
    }
    if (!previousSnapshotCount && requirements.length) {
      return rebuildSnapshotBaseline(snapshots, "snapshot-store-empty");
    }

    const missingRequirements = requirements.filter(
      (item) => !Object.hasOwn(previousSnapshots, item.recordId)
    );
    const newSinceLastScanCount = missingRequirements.filter(
      (item) => snapshotUpdatedAfter(item, lastScanAt)
    ).length;
    const missingRatio = requirements.length
      ? missingRequirements.length / requirements.length
      : 0;
    if (
      missingRequirements.length >= 20
      && missingRatio >= 0.25
      && newSinceLastScanCount / missingRequirements.length < 0.8
    ) {
      return rebuildSnapshotBaseline(
        snapshots,
        `snapshot-store-incomplete-${missingRequirements.length}-of-${requirements.length}`
      );
    }

    const candidates = [];
    const changedRequirementIds = new Set();
    const deferredRequirementIds = [];
    for (const requirement of requirements) {
      const previous = state.getRequirementSnapshot(requirement.recordId);
      const snapshot = snapshots[requirement.recordId];
      // If a single old record disappears from local state, silently restore
      // its baseline. Only a first-seen record updated after the previous
      // successful scan is considered a genuine new requirement.
      if (!previous && !snapshotUpdatedAfter(requirement, lastScanAt)) continue;
      if (previous && (previous.notificationMarker || '') === snapshot.notificationMarker &&
          !diffRequirementSnapshots(previous, snapshot).length) continue;
      let segments = [{ previous, snapshot, segmentId: '' }];
      if (confirmedSourceEnabled()) {
        try {
          if (!reconcileWorkflow) throw new Error('Managed workflow reconciliation is not configured');
          const edges = await reconcileWorkflow(requirement.recordId, previous?.notificationMarker || '', snapshot.notificationMarker || '');
          segments = nativeWorkflowSegments(previous, snapshot, edges, requirementSnapshot, IMPORTANT_FIELDS);
        } catch {
          // An unconfirmed write blocks only this record, never the entire team.
          // Keep the old baseline and scan time so even first-seen records retry.
          if (previous) snapshots[requirement.recordId] = previous;
          else delete snapshots[requirement.recordId];
          deferredRequirementIds.push(requirement.recordId);
          continue;
        }
      }
      for (const segment of segments) {
      const previous = segment.previous, snapshot = segment.snapshot;
      const changes = diffRequirementSnapshots(previous, snapshot);
      if (changes.length) {
        changedRequirementIds.add(requirement.recordId);
        candidates.push({
          type: "需求变更",
          segmentId: segment.segmentId,
          requirement,
          previous,
          snapshot,
          changes,
          eventIterationIds: snapshot.iterationIds || []
        });
        const previousIterations = new Set(previous?.iterationIds || []);
        const addedIterations = (snapshot.iterationIds || [])
          .filter((iterationId) => !previousIterations.has(iterationId));
        if (addedIterations.length) {
          candidates.push({
            type: "需求新增",
            segmentId: segment.segmentId,
            requirement,
            previous,
            snapshot,
            changes,
            eventIterationIds: addedIterations
          });
        }
      }
      }
    }
    const maxChangedRequirements = Number(
      config.runtime.collaborationMaxChangedRequirementsPerScan || 20
    );
    const maxEvents = Number(config.runtime.collaborationMaxEventsPerScan || 30);
    if (
      changedRequirementIds.size > maxChangedRequirements
      || candidates.length > maxEvents
    ) {
      const reason = [
        `单次扫描发现 ${changedRequirementIds.size} 项需求发生变化`,
        `计划生成 ${candidates.length} 个通知事件`,
        `超过安全阈值 ${maxChangedRequirements} 项/${maxEvents} 事件，已整批隔离`
      ].join("；");
      const first = candidates[0];
      const incidentKey = `安全隔离:${createHash("sha256")
        .update(JSON.stringify(candidates.map((item) => [
          item.requirement.recordId,
          requirementFingerprint(item.snapshot),
          item.type
        ])))
        .digest("hex")}`.slice(0, 200);
      await base.createCollaborationEvent(incidentKey, {
        "事件类型": "安全隔离",
        "需求": first ? [{ id: first.requirement.recordId }] : [],
        "迭代": [],
        "目标群": [],
        "状态": "已忽略",
        "触发来源": "通知安全阈值",
        "变更字段": "批量变更",
        "尝试次数": 0,
        "错误信息": reason.slice(0, 1000),
        "处理时间": dateTimeText(now(), config.runtime.timezone),
        "负载摘要": reason.slice(0, 500)
      });
      await state.replaceRequirementSnapshots(snapshots);
      if (deferredRequirementIds.length) throw new Error(`Workflow source reconciliation deferred for ${deferredRequirementIds.length} requirements; unchanged baselines retained`);
      if (state.setCollaborationLastScanAt) {
        await state.setCollaborationLastScanAt(now().toISOString());
      }
      log("error", "[collaboration] notification batch quarantined", {
        changedRequirements: changedRequirementIds.size,
        plannedEvents: candidates.length
      });
      return {
        baseline: false,
        quarantined: true,
        reason,
        changedRequirements: changedRequirementIds.size,
        plannedEvents: candidates.length,
        events: 0
      };
    }
    for (const candidate of candidates) {
      await enqueueChangeEvent(
        candidate.type,
        candidate.requirement,
        candidate.previous,
        candidate.snapshot,
        candidate.changes,
        candidate.eventIterationIds,
        candidate.segmentId
      );
    }
    // Persist the complete snapshot set once per scan. Writing every record
    // separately causes needless disk contention and can race with chat-state
    // updates handled by the same process.
    await state.replaceRequirementSnapshots(snapshots);
    if (deferredRequirementIds.length) throw new Error(`Workflow source reconciliation deferred for ${deferredRequirementIds.length} requirements; unchanged baselines retained`);
    if (state.setCollaborationLastScanAt) {
      await state.setCollaborationLastScanAt(now().toISOString());
    }
    return { baseline: false, events: candidates.length };
  }

  async function notifyIterationGroups(event, currentRequirement) {
    if (currentRequirement?.type === "工单") return { notified: 0, skipped: "ticket_not_iteration" };
    const next = parseEventSnapshot(event.fields["变更后"], null);
    const requirement = requirementAtEvent(currentRequirement, next);
    const iterationIds = event.iterationIds || requirement.iterationIds || [];
    const iterations = (await Promise.all(
      iterationIds.map((id) => base.getIterationById(id))
    )).filter(Boolean);
    let chats;
    if (Array.isArray(event.targetChatIds)) {
      chats = [...new Set(event.targetChatIds.filter(Boolean))];
    } else {
      const bindings = [];
      for (const iteration of iterations) {
        bindings.push(...await base.listBindingsForIteration(iteration));
      }
      chats = [...new Set(
        bindings.map((item) => base.valueText(item.fields["群聊ID"])).filter(Boolean)
      )];
    }
    if (!chats.length) return { ignored: true, reason: "新纳入的迭代没有启用的绑定群" };
    const maxTargets = Number(config.runtime.notificationMaxTargetsPerEvent || 12);
    if (chats.length > maxTargets) {
      const reason = `单个需求新增事件包含 ${chats.length} 个目标群，超过安全阈值 ${maxTargets}，已整批隔离`;
      await base.updateRequirement(requirement.recordId, {
        "最近通知版本": event.eventKey,
        "最近通知摘要": reason
      });
      return { ignored: true, reason, safetyBlockedCount: chats.length };
    }

    const markdown = formatRequirementNotification({
      config,
      type: "需求新增",
      requirement,
      iterationNames: iterations.map((item) => base.valueText(item.fields["迭代名称"])),
      changes: []
    });
    let deliveredCount = 0;
    let blockedCount = 0;
    let safetyBlockedCount = 0;
    for (const chatId of chats) {
      const delivery = await sendMarkdown(
        chatId,
        markdown,
        `collab-${createHash("sha1").update(`${event.eventKey}:${chatId}`).digest("hex")}`.slice(0, 50),
        { purpose: "iteration-requirement-created", eventId:event.eventKey, requirementId:requirement.recordId }
      );
      if (delivery?.safetyBlocked) safetyBlockedCount += 1;
      else if (delivery?.blocked) blockedCount += 1;
      else deliveredCount += 1;
    }
    const notificationFields = {
      "最近通知版本": event.eventKey,
      "最近通知摘要": deliveredCount
        ? `${event.type}已通知 ${deliveredCount} 个迭代群，策略隔离 ${blockedCount} 个目标，安全拦截 ${safetyBlockedCount} 个目标`
        : safetyBlockedCount
          ? `${event.type}触发通知安全阈值，拦截 ${safetyBlockedCount} 个目标，未向外发送`
          : `${event.type}在通知隔离期拦截 ${blockedCount} 个目标，未向外发送`
    };
    if (process.env.WORKFLOW_DELIVERY_OWNER === 'managed_bot') notificationFields["最近通知摘要"] = `通知已交由统一投递台账处理，${deliveredCount} 个目标已接收；实际发送结果请查看台账`;
    if (deliveredCount && process.env.WORKFLOW_DELIVERY_OWNER !== 'managed_bot') {
      notificationFields["最近通知时间"] = dateTimeText(now(), config.runtime.timezone);
    }
    await base.updateRequirement(requirement.recordId, notificationFields);
    return {
      ignored: deliveredCount === 0,
      reason: deliveredCount === 0 ? "通知隔离期已拦截全部目标" : "",
      chatCount: deliveredCount,
      blockedCount,
      safetyBlockedCount
    };
  }

  async function notifyRequirementChanges(event, currentRequirement) {
    const previous = parseEventSnapshot(event.fields["变更前"], null);
    const next = parseEventSnapshot(event.fields["变更后"], null);
    if (!next) return { ignored: true, reason: "协作事件缺少有效的变更后快照" };
    const requirement = requirementAtEvent(currentRequirement, next);
    const changes = diffRequirementSnapshots(previous, next);
    if (!changes.length) return { ignored: true, reason: "协作事件没有实际字段变化" };

    const context = await resolveRequirementChangeContext(
      base,
      previous,
      next,
      changes
    );
    const plans = buildRequirementNotificationPlan({
      config,
      requirement,
      previous,
      next,
      changes: context.changes,
      iterationNames: context.iterationNames
    });
    if (!plans.length) {
      return {
        ignored: true,
        reason: "没有新增人员，且当前处理人为空或没有需要通知的字段变化"
      };
    }

    const maxTargets = Number(config.runtime.notificationMaxTargetsPerEvent || 12);
    if (plans.length > maxTargets) {
      const reason = `单个需求变更事件包含 ${plans.length} 个通知目标，超过安全阈值 ${maxTargets}，已整批隔离`;
      await base.updateRequirement(requirement.recordId, {
        "最近通知版本": event.eventKey,
        "最近通知摘要": reason
      });
      return { ignored: true, reason, safetyBlockedCount: plans.length };
    }

    const failures = [];
    let userCount = 0;
    let chatCount = 0;
    let blockedUserCount = 0;
    let blockedChatCount = 0;
    let safetyBlockedCount = 0;
    for (const plan of plans) {
      const target = plan.channel === "chat"
        ? { chatId: plan.targetId }
        : { userId: plan.targetId };
      const key = `notice-${createHash("sha1")
        .update(`${event.eventKey}:${plan.channel}:${plan.targetId}:${plan.kind}`)
        .digest("hex")}`.slice(0, 50);
      try {
        const delivery = await sendCard(target, plan.card, key, {
          purpose: `requirement-${plan.kind}`, eventId:event.eventKey, requirementId:requirement.recordId
        });
        if (delivery?.safetyBlocked) {
          safetyBlockedCount += 1;
        } else if (delivery?.blocked) {
          if (plan.channel === "chat") blockedChatCount += 1;
          else blockedUserCount += 1;
        } else if (plan.channel === "chat") chatCount += 1;
        else userCount += 1;
      } catch (error) {
        failures.push(`${plan.channel}:${plan.targetId} ${error.message}`);
      }
    }
    if (failures.length) {
      throw new Error(`通知发送失败 ${failures.length}/${plans.length}：${failures.join("；")}`);
    }

    const blockedCount = blockedUserCount + blockedChatCount;
    const deliveredCount = userCount + chatCount;
    const notificationFields = {
      "最近通知版本": event.eventKey,
      "最近通知摘要": deliveredCount
        ? `需求变更已私聊 ${userCount} 人、通知 ${chatCount} 个需求群，策略隔离 ${blockedCount} 个目标，安全拦截 ${safetyBlockedCount} 个目标`
        : safetyBlockedCount
          ? `需求变更触发通知安全阈值，拦截 ${safetyBlockedCount} 个目标，未向外发送`
          : `需求变更在通知隔离期拦截 ${blockedCount} 个目标，未向外发送`
    };
    if (process.env.WORKFLOW_DELIVERY_OWNER === 'managed_bot') notificationFields["最近通知摘要"] = `通知已交由统一投递台账处理，私聊 ${userCount} 人、群聊 ${chatCount} 个；实际发送结果请查看台账`;
    if (deliveredCount && process.env.WORKFLOW_DELIVERY_OWNER !== 'managed_bot') {
      notificationFields["最近通知时间"] = dateTimeText(now(), config.runtime.timezone);
    }
    await base.updateRequirement(requirement.recordId, notificationFields);
    return {
      ignored: deliveredCount === 0,
      reason: deliveredCount === 0 ? "通知隔离期已拦截全部目标" : "",
      userCount,
      chatCount,
      blockedUserCount,
      blockedChatCount,
      safetyBlockedCount
    };
  }

  async function executeEvent(event) {
    const requirement = await base.getRequirementById(event.requirementIds[0]);
    if (!requirement) throw new Error("协作事件关联的需求已不存在");
    if (event.type === "需求新增") {
      return notifyIterationGroups(event, requirement);
    }
    if (event.type === "需求变更") return notifyRequirementChanges(event, requirement);
    if (event.type === "创建需求群") {
      return createRequirementGroup({ config, base, cli, requirement, sendMarkdown, now: now() });
    }
    if (event.type === "同步群成员") {
      return syncRequirementGroup({ config, base, cli, requirement, now: now() });
    }
    return { ignored: true, reason: "该事件由驾驶舱直接执行" };
  }

  async function processEvent(event) {
    if (["已发送", "已忽略"].includes(event.status)) return { skipped: true };
    const attempts = event.attempts + 1;
    await base.updateCollaborationEvent(event.recordId, {
      "状态": "处理中",
      "尝试次数": attempts,
      "错误信息": ""
    });
    try {
      const result = await executeEvent(event);
      await base.updateCollaborationEvent(event.recordId, {
        "状态": result.ignored ? "已忽略" : "已发送",
        "错误信息": result.reason || "",
        "下次重试时间": null,
        "处理时间": dateTimeText(now(), config.runtime.timezone)
      });
      return { ok: true, ...result };
    } catch (error) {
      const maxAttempts = config.runtime.collaborationMaxAttempts || 5;
      const retryBase = config.runtime.collaborationRetryBaseSeconds || 30;
      const retryAt = new Date(now().getTime() + retryBase * (2 ** Math.max(0, attempts - 1)) * 1000);
      await base.updateCollaborationEvent(event.recordId, {
        "状态": "失败",
        "错误信息": String(error?.message || error).slice(0, 1000),
        "下次重试时间": attempts < maxAttempts
          ? dateTimeText(retryAt, config.runtime.timezone)
          : null
      });
      throw error;
    }
  }

  async function processPendingEvents() {
    const currentTime = now().getTime();
    const maxAttempts = config.runtime.collaborationMaxAttempts || 5;
    const events = (await base.listCollaborationEvents()).filter((event) => {
      if (event.status === "待处理") return true;
      if (event.status !== "失败" || event.attempts >= maxAttempts || !event.retryAt) return false;
      const retryTime = Date.parse(String(event.retryAt).replace(" ", "T"));
      return !Number.isNaN(retryTime) && retryTime <= currentTime;
    });
    const results = [];
    for (const event of events) {
      try {
        results.push(await processEvent(event));
      } catch (error) {
        log("error", `[collaboration] event failed key=${event.eventKey}`, error.message);
        results.push({ ok: false, error: error.message });
      }
    }
    return results;
  }

  async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    try {
      const scan = await scanRequirements();
      const processed = await processPendingEvents();
      return { scan, processed };
    } finally {
      running = false;
    }
  }

  async function runGroupAction(type, requirement, source = "Agent") {
    const eventKey = `${source}:${type}:${requirement.recordId}:${randomUUID()}`.slice(0, 200);
    const event = await base.createCollaborationEvent(eventKey, {
      "事件类型": type,
      "需求": [{ id: requirement.recordId }],
      "迭代": (requirement.iterationIds || []).map((id) => ({ id })),
      "状态": "待处理",
      "触发来源": source,
      "尝试次数": 0,
      "负载摘要": `${type}：${requirement.title}`.slice(0, 500)
    });
    return processEvent(event);
  }

  return {
    scanRequirements,
    processPendingEvents,
    processEvent,
    runOnce,
    runGroupAction
  };
}
