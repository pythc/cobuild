import {
  iterationRecordUrl,
  requirementRecordUrl
} from "./requirement-links.js";

const DONE_STATUSES = new Set(["已发布"]);

function timestamp(value) {
  if (!value) return null;
  if (typeof value === "number") return value;
  const text = String(value).trim();
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? `${normalized}T00:00:00`
    : normalized;
  const parsed = Date.parse(
    /Z$|[+-]\d{2}:?\d{2}$/.test(withTime) ? withTime : `${withTime}+08:00`
  );
  return Number.isNaN(parsed) ? null : parsed;
}

function dateText(value) {
  const time = timestamp(value);
  if (!time) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(time);
}

function mentionList(people) {
  if (!people?.length) return "未分配处理人";
  return people.map((person) => `<at user_id="${person.id}">${person.name || ""}</at>`).join("、");
}

const STATUS_RANK = new Map([
  ["需求待评审", 0],
  ["已评审", 1],
  ["开发中", 2],
  ["开发转测试", 3],
  ["测试中", 4],
  ["产品体验中", 5],
  ["待发布", 6],
  ["发布中", 7],
  ["已发布", 8]
]);

const MILESTONE_RULES = [
  {
    key: "review",
    field: "需求评审时间",
    heading: "需求评审时间已过未完成评审",
    targetRank: 1,
    peopleFields: ["handlers", "productOwners"]
  },
  {
    key: "development",
    field: "开发启动时间",
    heading: "开发时间已过未完成开发",
    targetRank: 3,
    peopleFields: ["handlers", "developers"]
  },
  {
    key: "testing",
    field: "提测时间",
    heading: "提测时间已过仍未完成测试",
    targetRank: 5,
    peopleFields: ["handlers", "testers"]
  },
  {
    key: "release",
    field: "发布时间",
    heading: "发布时间已过仍未发布",
    targetRank: 8,
    peopleFields: ["handlers", "developers", "testers", "productOwners"]
  }
];

function endOfMilestone(value) {
  const time = timestamp(value);
  if (!time) return null;
  const text = String(value).trim();
  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(time));
  const clock = Object.fromEntries(timeParts.map((part) => [part.type, part.value]));
  const isMidnight =
    clock.hour === "00" &&
    clock.minute === "00" &&
    clock.second === "00";
  return (/^\d{4}-\d{2}-\d{2}$/.test(text) || isMidnight)
    ? time + 24 * 60 * 60 * 1000 - 1
    : time;
}

function uniquePeople(items) {
  const result = [];
  const seen = new Set();
  for (const item of items.flat()) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function requirementPeople(item) {
  const status = item.status || "";
  const groups = [item.handlers || []];
  if (["需求待评审", "产品体验中", "待发布", "发布中"].includes(status)) {
    groups.push(item.productOwners || []);
  }
  if (["已评审", "开发中", "开发转测试", "待发布", "发布中"].includes(status)) {
    groups.push(item.developers || []);
  }
  if (["开发转测试", "测试中", "产品体验中", "待发布", "发布中"].includes(status)) {
    groups.push(item.testers || []);
  }
  if (item.blocked) {
    groups.push(item.productOwners || [], item.developers || [], item.testers || []);
  }
  return uniquePeople(groups);
}

function milestoneDateText(value, timezone = "Asia/Shanghai") {
  const time = timestamp(value);
  if (!time) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).format(time);
}

export function classifyMilestoneOverdue(iteration, requirements, now = Date.now()) {
  const groups = MILESTONE_RULES.map((rule) => {
    const value = iteration.fields[rule.field];
    const deadline = endOfMilestone(value);
    return { ...rule, value, deadline, daysOverdue: deadline ? Math.max(1, Math.ceil((now - deadline) / 86_400_000)) : 0, items: [] };
  });

  for (const item of requirements) {
    const rank = STATUS_RANK.get(item.status) ?? 0;
    if (rank >= 8) continue;
    const group = groups.find((candidate) =>
      candidate.deadline && now > candidate.deadline && rank < candidate.targetRank
    );
    if (!group) continue;
    group.items.push({
      ...item,
      mentions: uniquePeople(group.peopleFields.map((field) => item[field] || []))
    });
  }
  return groups.filter((group) => group.items.length);
}

export function formatMilestoneReminder(
  iteration,
  requirements,
  _links = {},
  { now = Date.now(), timezone = "Asia/Shanghai", config = null } = {}
) {
  const name = iteration.fields["迭代名称"] || "未命名迭代";
  const groups = classifyMilestoneOverdue(iteration, requirements, now);
  const lines = [`#### 【${name}】里程碑逾期催办`];

  if (!groups.length) {
    lines.push("", "当前没有超过里程碑截止时间且阶段未达标的需求。");
    return lines.join("\n");
  }

  for (const group of groups) {
    lines.push(
      "",
      `##### ${group.heading}`,
      `> ${milestoneDateText(group.value, timezone)} 已截止，逾期 ${group.daysOverdue} 天，共 ${group.items.length} 项`
    );
    for (const item of group.items) {
      const fallback = requirementRecordUrl(config || {}, item.recordId);
      lines.push(
        `- [${item.title}](${fallback}) · ${item.status} · ${item.priority}`,
        `  ${mentionList(item.mentions)}`
      );
    }
  }
  lines.push("", "> 请相关人员尽快推进，并及时更新状态和进展。");
  return lines.join("\n");
}

export function analyzeRequirements(requirements, now = Date.now()) {
  const byStatus = new Map();
  const unfinished = [];
  const overdue = [];
  const unassigned = [];
  const blocked = [];

  for (const item of requirements) {
    byStatus.set(item.status, (byStatus.get(item.status) || 0) + 1);
    if (!DONE_STATUSES.has(item.status)) {
      unfinished.push(item);
      if (item.blocked) blocked.push(item);
      const due = endOfMilestone(item.deadline);
      if (due && due < now) overdue.push(item);
      if (!item.handlers.length && !item.developers.length) unassigned.push(item);
    }
  }

  return {
    total: requirements.length,
    done: requirements.length - unfinished.length,
    unfinished,
    overdue,
    unassigned,
    blocked,
    byStatus
  };
}

export function selectReminderTargets(requirements, now = Date.now()) {
  const analysis = analyzeRequirements(requirements, now);
  return [
    ...analysis.blocked,
    ...analysis.overdue.filter((item) => !analysis.blocked.includes(item)),
    ...analysis.unassigned.filter(
      (item) =>
        !analysis.blocked.includes(item) &&
        !analysis.overdue.includes(item)
    )
  ];
}

export function selectProgressTargets(
  requirements,
  now = Date.now(),
  staleDays = 3
) {
  const staleBefore = now - staleDays * 86_400_000;
  return requirements.filter((item) => {
    if (DONE_STATUSES.has(item.status)) return false;
    if (!String(item.latestProgress || "").trim()) return true;
    const updatedAt = timestamp(item.updatedAt);
    return updatedAt !== null && updatedAt <= staleBefore;
  });
}

export function formatIterationList(iterations, valueText) {
  if (!iterations.length) return "当前还没有迭代。可以发送：`创建迭代 迭代名称 2026-08-01 至 2026-08-14`";
  const lines = iterations.map((item) => {
    const name = valueText(item.fields["迭代名称"]);
    const status = valueText(item.fields["状态"]) || "未设置";
    return `- **${name}** · ${status} · ${dateText(item.fields["开始时间"])}—${dateText(item.fields["结束时间"])}`;
  });
  return `#### 迭代列表\n\n${lines.join("\n")}`;
}

export function formatReport(iteration, requirements, config) {
  const analysis = analyzeRequirements(requirements);
  const name = iteration.fields["迭代名称"];
  const statuses = [...analysis.byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status} ${count}`)
    .join("｜") || "暂无需求";
  const percent = analysis.total ? Math.round((analysis.done / analysis.total) * 100) : 0;

  const lines = [
    `#### ${name} · 需求进展`,
    "",
    `- 总计 **${analysis.total}**，已发布 **${analysis.done}**，完成率 **${percent}%**`,
    `- 状态分布：${statuses}`,
    `- 逾期未完成：**${analysis.overdue.length}**`,
    `- 当前阻塞：**${analysis.blocked.length}**`,
    `- 未分配处理人：**${analysis.unassigned.length}**`
  ];

  const risks = [
    ...analysis.blocked,
    ...analysis.overdue.filter((item) => !analysis.blocked.includes(item)),
    ...analysis.unassigned.filter((item) => !analysis.blocked.includes(item) && !analysis.overdue.includes(item))
  ];
  if (risks.length) {
    lines.push("", "##### 需要关注");
    for (const item of risks.slice(0, config.runtime.maxRequirementLines)) {
      const owners = requirementPeople(item);
      const tags = [
        item.blocked ? `阻塞：${item.blocker || "未填写原因"}` : null,
        analysis.overdue.includes(item) ? `逾期 ${dateText(item.deadline)}` : null,
        !owners.length ? "未分配" : null
      ].filter(Boolean).join("、");
      lines.push(
        `- [${item.title}](${requirementRecordUrl(config, item.recordId)}) · ${item.priority} · ${item.status} · ${tags || "需关注"} · ${mentionList(owners)}`
      );
    }
    if (risks.length > config.runtime.maxRequirementLines) {
      lines.push(`- 另有 ${risks.length - config.runtime.maxRequirementLines} 项，请在需求平台查看`);
    }
  }
  if (risks.length) lines.push("", "> 请相关人员尽快推进，并及时更新状态和进展。");
  lines.push("", `[打开当前迭代](${iterationRecordUrl(config, iteration.recordId)})`);
  return lines.join("\n");
}

export function formatReminder(
  iteration,
  requirements,
  config,
  { now = Date.now() } = {}
) {
  const targets = selectReminderTargets(requirements, now);
  const lines = [
    `#### ${iteration.fields["迭代名称"]} · 催办提醒`,
    "",
    targets.length
      ? `以下 **${targets.length}** 项需求存在阻塞、截止逾期或未分配，请及时处理并更新进展：`
      : "当前没有阻塞、截止逾期或未分配的风险需求。"
  ];

  if (!targets.length) {
    lines.push("", "当前迭代没有待催办需求。");
  } else {
    for (const item of targets) {
      const owners = requirementPeople(item);
      const risk = item.blocked ? ` · 阻塞：${item.blocker || "未填写原因"}` : "";
      lines.push(
        `- [${item.title}](${requirementRecordUrl(config, item.recordId)}) · ${item.priority} · ${item.status} · 截止 ${dateText(item.deadline)}${risk} · ${mentionList(owners)}`
      );
    }
    lines.push("", "> 请相关人员尽快推进，并及时更新状态和进展。");
  }
  lines.push("", `[打开当前迭代](${iterationRecordUrl(config, iteration.recordId)})`);
  return lines.join("\n");
}

export function formatProgressCollection(
  iteration,
  requirements,
  config,
  { now = Date.now(), staleDays = 3 } = {}
) {
  const targets = selectProgressTargets(requirements, now, staleDays);
  const lines = [
    `#### ${iteration.fields["迭代名称"]} · 进展更新`,
    "",
    targets.length
      ? `以下 **${targets.length}** 项需求未填写进展或已连续 ${staleDays} 天未更新，请补充最新进展、下一步计划、预计完成时间及阻塞情况：`
      : `当前没有未填写进展或连续 ${staleDays} 天未更新的需求。`
  ];

  for (const item of targets) {
    const people = uniquePeople([
      item.handlers || [],
      item.productOwners || [],
      item.developers || [],
      item.testers || []
    ]);
    lines.push(
      `- [${item.title}](${requirementRecordUrl(config, item.recordId)}) · ${item.priority} · ${item.status} · 当前进展：${item.latestProgress || "未填写"}`,
      `  ${mentionList(people)}`
    );
  }
  if (targets.length) {
    lines.push("", "> 请相关人员在今日内完成更新，并及时同步阻塞情况。");
  }
  lines.push("", `[打开当前迭代](${iterationRecordUrl(config, iteration.recordId)})`);
  return lines.join("\n");
}

export function helpText() {
  return [
    "#### 迭代机器人指令",
    "",
    "- `创建迭代 名称 2026-08-01 至 2026-08-14`（管理员）",
    "- `删除迭代 迭代名称`（管理员）",
    "- `迭代列表`",
    "- `绑定到 迭代名称`（管理员，仅群聊）",
    "- `当前绑定` / `解绑`（解绑仅管理员）",
    "- `迭代情况`",
    "- `催办`",
    "- `设置日报 09:30`（管理员）",
    "- `设置周报 周一 09:30`（管理员）",
    "- `关闭自动发布`（管理员）",
    "",
    "群聊中请先 @机器人，再发送指令。"
  ].join("\n");
}
