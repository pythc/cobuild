import { requirementRecordUrl } from "./response-policy.js";

export const PERSONNEL_FIELDS = [
  { key: "proposers", label: "提出人" },
  { key: "handlers", label: "当前处理人" },
  { key: "productOwners", label: "产品人员" },
  { key: "developers", label: "研发人员" },
  { key: "testers", label: "测试人员" },
  { key: "foOwners", label: "FO" },
  { key: "followers", label: "关注人" },
  { key: "releaseOwners", label: "发布负责人" }
];

const isTicket = (r) => r?.type === "工单";
const ticketClosing = (r) => ["已解决", "已关闭"].includes(r.status) ? "处理结果已更新，可打开工单查看。" : "请打开工单跟进处理。";
const TICKET_FIELDS = new Set(["handlers", "title", "status", "priority", "introduction", "latestProgress", "blocked", "blocker", "deadline"]);

const PERSONNEL_KEYS = new Set(PERSONNEL_FIELDS.map((item) => item.key));

const STATUS_ROLE_KEYS = {
  "需求待评审": ["productOwners"],
  "已评审": ["productOwners", "developers"],
  "开发中": ["developers"],
  "开发转测试": ["developers", "testers"],
  "测试中": ["testers"],
  "产品体验中": ["productOwners", "testers"],
  "待发布": ["productOwners", "developers", "testers", "releaseOwners"],
  "发布中": ["productOwners", "developers", "testers", "releaseOwners"],
  "已发布": ["productOwners", "developers", "testers", "releaseOwners"],
  "新建": ["handlers"],
  "处理中": ["developers"],
  "待验证": ["developers", "testers"],
  "已验证": ["testers"],
  "重新打开": ["developers", "testers"],
  "已拒绝": ["handlers"],
  "已关闭": ["handlers", "testers"]
};

const STATUS_THEME = {
  "需求待评审": { template: "blue", tag: "blue" },
  "已评审": { template: "wathet", tag: "wathet" },
  "开发中": { template: "orange", tag: "orange" },
  "开发转测试": {
    template: "turquoise",
    tag: "turquoise"
  },
  "测试中": { template: "wathet", tag: "wathet" },
  "产品体验中": {
    template: "violet",
    tag: "violet"
  },
  "待发布": { template: "purple", tag: "purple" },
  "发布中": {
    template: "turquoise",
    tag: "turquoise"
  },
  "已发布": { template: "green", tag: "green" },
  "新建": { template: "blue", tag: "blue" },
  "处理中": { template: "orange", tag: "orange" },
  "待验证": { template: "wathet", tag: "wathet" },
  "已验证": { template: "turquoise", tag: "turquoise" },
  "重新打开": { template: "purple", tag: "purple" },
  "已拒绝": { template: "red", tag: "red" },
  "已关闭": { template: "green", tag: "green" }
};

const DEFAULT_THEME = {
  template: "blue",
  tag: "blue"
};

function normalizedPeople(items = []) {
  return items
    .filter((item) => item?.id)
    .map((item) => ({ id: item.id, name: item.name || "" }));
}

function uniquePeople(items = []) {
  const result = [];
  const seen = new Set();
  for (const person of items) {
    if (!person?.id || seen.has(person.id)) continue;
    seen.add(person.id);
    result.push({ id: person.id, name: person.name || "" });
  }
  return result;
}

function escapeMarkdown(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&#60;")
    .replaceAll(">", "&#62;")
    .replaceAll("*", "&#42;")
    .replaceAll("~", "&#126;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("(", "&#40;")
    .replaceAll(")", "&#41;")
    .replaceAll("#", "&#35;");
}

function safeMentionId(value) {
  const id = String(value || "");
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
}

function mentionPeople(items = []) {
  const mentions = uniquePeople(items)
    .map((item) => safeMentionId(item.id))
    .filter(Boolean)
    .map((id) => `<at id=${id}></at>`);
  return mentions.join("、") || "未分配";
}

function peopleNames(items = []) {
  const names = uniquePeople(items)
    .map((item) => escapeMarkdown(item.name || item.id))
    .filter(Boolean);
  return names.join("、") || "未分配";
}

function textSummaryLength(value) {
  if (value && typeof value === "object" && Number.isFinite(value.__textLength)) {
    return value.__textLength;
  }
  return String(value || "").length;
}

function dateValue(value, timeZone) {
  const numeric = typeof value === "number"
    ? value
    : /^\d{13}$/.test(String(value || "")) ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(numeric)).replaceAll("/", "-");
}

function displayValue(value, key, timeZone) {
  if (["introduction", "acceptanceCriteria", "selfTestReport"].includes(key)) {
    const length = textSummaryLength(value);
    return length ? `已填写（${length} 字）` : "未填写";
  }
  if (Array.isArray(value)) {
    if (!value.length) return "未设置";
    if (typeof value[0] === "object") return peopleNames(value);
    return escapeMarkdown(value.join("、"));
  }
  if (value === true) return "是";
  if (value === false) return "否";
  if (value == null || value === "") return "未设置";
  const formattedDate = dateValue(value, timeZone);
  return escapeMarkdown(formattedDate || value);
}

function changeLine(change, timeZone) {
  const before = Object.hasOwn(change, "beforeDisplay")
    ? escapeMarkdown(change.beforeDisplay)
    : displayValue(change.before, change.key, timeZone);
  const after = Object.hasOwn(change, "afterDisplay")
    ? escapeMarkdown(change.afterDisplay)
    : displayValue(change.after, change.key, timeZone);
  return `- **${escapeMarkdown(change.label)}**：${before} → ${after}`;
}

function stageRoleGroups(requirement) {
  const keys = isTicket(requirement) ? [] : STATUS_ROLE_KEYS[requirement.status] || [];
  return keys.map((key) => {
    const field = PERSONNEL_FIELDS.find((item) => item.key === key);
    return {
      key,
      label: field?.label || key,
      people: uniquePeople(requirement[key] || [])
    };
  }).filter((item) => item.people.length);
}

function statusTheme(status) {
  return STATUS_THEME[status] || DEFAULT_THEME;
}

function baseCard({ title, subtitle, status, theme, summary, elements }) {
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      enable_forward: true,
      summary: { content: summary },
      style: {
        text_size: {
          title: { default: "heading-4", pc: "heading-4", mobile: "heading-4" },
          body: { default: "normal", pc: "normal", mobile: "normal" },
          caption: { default: "notation", pc: "notation", mobile: "notation" }
        }
      }
    },
    header: {
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: subtitle },
      template: theme.template,
      icon: { tag: "standard_icon", token: "wiki-bitable_colorful" },
      text_tag_list: [
        {
          tag: "text_tag",
          text: { tag: "plain_text", content: status || "未设置" },
          color: theme.tag
        }
      ]
    },
    body: {
      direction: "vertical",
      padding: "8px 12px 12px 12px",
      vertical_spacing: "8px",
      elements
    }
  };
  validateNotificationCard(card);
  return card;
}

function requirementFocus(config, requirement) {
  const url = requirementRecordUrl(config, requirement.recordId);
  return {
    tag: "markdown",
    content: `**[${escapeMarkdown(requirement.title || "未命名需求")}](${url})**`,
    text_size: "title"
  };
}

function summaryBlock(requirement, iterationNames) {
  if (isTicket(requirement)) return detailBlock("工单信息", `**工单编号**：${escapeMarkdown(requirement.code || "")}\n**优先级**：${escapeMarkdown(requirement.priority || "未设置")}`);
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        padding: "4px 8px",
        vertical_spacing: "4px",
        elements: [{
          tag: "markdown",
          content: `**所属迭代**\n${escapeMarkdown(iterationNames.join("、") || "未纳入迭代")}`
        }]
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        padding: "4px 8px",
        vertical_spacing: "4px",
        elements: [{
          tag: "markdown",
          content: `**项目 / 优先级**\n${escapeMarkdown(requirement.project || "未设置")} · ${escapeMarkdown(requirement.priority || "未设置")}`
        }]
      }
    ]
  };
}

function detailBlock(title, content) {
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      padding: "4px 8px",
      vertical_spacing: "4px",
      elements: [{
        tag: "markdown",
        content: `**${escapeMarkdown(title)}**\n${content}`
      }]
    }]
  };
}

function responsibilityBlock(lines, closing) {
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      padding: "4px 8px",
      vertical_spacing: "4px",
      elements: [{
        tag: "markdown",
        content: [...lines, "", `> ${escapeMarkdown(closing)}`].join("\n")
      }]
    }]
  };
}

function viewButton(config, requirement) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: isTicket(requirement) ? "查看工单" : "查看需求" },
    type: "primary_filled",
    size: "small",
    width: "fill",
    behaviors: [{
      type: "open_url",
      default_url: requirementRecordUrl(config, requirement.recordId)
    }]
  };
}

function actorText(actor) {
  return escapeMarkdown(actor?.name || "周灿宇");
}

export function resolveChangeActor(config, snapshot = {}) {
  const modifiedBy = snapshot.modifiedBy;
  if (modifiedBy?.id && modifiedBy.id !== config.botOpenId) {
    return { id: modifiedBy.id, name: modifiedBy.name || modifiedBy.id };
  }
  const fallback = config.notifications?.defaultActor;
  if (fallback?.id) return { id: fallback.id, name: fallback.name || fallback.id };
  return {
    id: config.authorization?.ownerOpenIds?.[0] || "",
    name: config.notifications?.defaultActorName || "管理员"
  };
}

export function buildAssignmentCard({
  config,
  requirement,
  iterationNames,
  actor,
  roles
}) {
  const theme = statusTheme(requirement.status);
  const roleText = roles.map((item) => escapeMarkdown(item)).join("、") || "相关人员";
  return baseCard({
    title: isTicket(requirement) ? "您收到一张新工单" : "您收到一项新的工作",
    subtitle: `来自 ${actor?.name || "管理员"}`,
    status: requirement.status,
    theme,
    summary: `新工作：${requirement.title}`,
    elements: [
      requirementFocus(config, requirement),
      summaryBlock(requirement, iterationNames),
      detailBlock(
        "工作指派",
        `**修改人**：${actorText(actor)}\n**分配字段**：${roleText}\n**当前状态**：${escapeMarkdown(requirement.status || "未设置")}`
      ),
      responsibilityBlock(
        [`**当前处理人**：${peopleNames(requirement.handlers || [])}`],
        isTicket(requirement) ? ticketClosing(requirement) : "请及时确认并推进后续工作。"
      ),
      viewButton(config, requirement)
    ]
  });
}

export function buildChangeCard({
  config,
  requirement,
  iterationNames,
  actor,
  changes
}) {
  const statusChange = changes.find((item) => item.key === "status");
  const theme = statusTheme(requirement.status);
  const visibleChanges = changes.slice(0, 12).map(item => isTicket(requirement) && ["introduction", "latestProgress"].includes(item.key) ? {...item, label: item.key === "introduction" ? "问题描述" : "处理进展", beforeDisplay: "", afterDisplay: "已更新，请打开工单查看"} : item);
  const omitted = Math.max(0, changes.length - visibleChanges.length);
  const changeText = [
    ...visibleChanges.map((item) => changeLine(item, config.runtime?.timezone || "Asia/Shanghai")),
    ...(omitted ? [`- 另有 ${omitted} 项变更，请打开需求查看`] : [])
  ].join("\n");
  return baseCard({
    title: isTicket(requirement) ? (statusChange ? "工单状态更新" : "您负责的工单已更新") : (statusChange ? "需求状态已更新" : "您负责的需求已更新"),
    subtitle: `由 ${actor?.name || "管理员"} 修改`,
    status: requirement.status,
    theme,
    summary: `${statusChange ? "状态流转" : "需求更新"}：${requirement.title}`,
    elements: [
      requirementFocus(config, requirement),
      summaryBlock(requirement, iterationNames),
      detailBlock(statusChange ? "状态流转" : "变更内容", changeText),
      responsibilityBlock(
        [`**当前处理人**：${peopleNames(requirement.handlers || [])}`],
        isTicket(requirement) ? ticketClosing(requirement) : "请及时核对变更并推进后续工作。"
      ),
      viewButton(config, requirement)
    ]
  });
}

export function buildStatusGroupCard({
  config,
  requirement,
  iterationNames,
  actor,
  statusChange
}) {
  const theme = statusTheme(requirement.status);
  const stageGroups = stageRoleGroups(requirement);
  const responsibilityLines = [
    `**当前处理人**：${mentionPeople(requirement.handlers || [])}`,
    ...stageGroups.map((item) => `**${escapeMarkdown(item.label)}**：${mentionPeople(item.people)}`)
  ];
  return baseCard({
    title: isTicket(requirement) ? "工单状态更新" : "需求状态更新通知",
    subtitle: `由 ${actor?.name || "管理员"} 流转`,
    status: requirement.status,
    theme,
    summary: `状态更新：${requirement.title}`,
    elements: [
      requirementFocus(config, requirement),
      summaryBlock(requirement, iterationNames),
      detailBlock(
        "状态流转",
        `**操作人**：${actorText(actor)}\n**状态**：${displayValue(statusChange.before, "status")} → ${displayValue(statusChange.after, "status")}`
      ),
      responsibilityBlock(
        responsibilityLines,
        isTicket(requirement) ? ticketClosing(requirement) : "请相关人员尽快推进，并及时更新状态和进展。"
      ),
      viewButton(config, requirement)
    ]
  });
}

export function buildRequirementNotificationPlan({
  config,
  requirement,
  previous,
  next,
  changes,
  iterationNames
}) {
  if (isTicket(requirement)) changes = changes.filter(item => TICKET_FIELDS.has(item.key));
  if (!changes.length) return [];
  const actor = resolveChangeActor(config, next);
  const assignments = new Map();
  for (const field of isTicket(requirement) ? PERSONNEL_FIELDS.filter(f => f.key === "handlers") : PERSONNEL_FIELDS) {
    const oldIds = new Set(normalizedPeople(previous?.[field.key] || []).map((item) => item.id));
    for (const person of normalizedPeople(next?.[field.key] || [])) {
      if (oldIds.has(person.id)) continue;
      const existing = assignments.get(person.id) || { person, roles: [] };
      existing.roles.push(field.label);
      assignments.set(person.id, existing);
    }
  }

  const plans = [];
  for (const { person, roles } of assignments.values()) {
    plans.push({
      channel: "user",
      targetId: person.id,
      kind: "assignment",
      card: buildAssignmentCard({
        config,
        requirement,
        iterationNames,
        actor,
        roles
      })
    });
  }

  const nonPersonnelChanges = changes.filter((item) => !PERSONNEL_KEYS.has(item.key));
  if (nonPersonnelChanges.length) {
    for (const handler of uniquePeople(next.handlers || [])) {
      if (assignments.has(handler.id)) continue;
      plans.push({
        channel: "user",
        targetId: handler.id,
        kind: nonPersonnelChanges.some((item) => item.key === "status") ? "status" : "change",
        card: buildChangeCard({
          config,
          requirement,
          iterationNames,
          actor,
          changes: nonPersonnelChanges
        })
      });
    }
  }

  const statusChange = changes.find((item) => item.key === "status");
  const handlerChange = isTicket(requirement) && changes.find(item => item.key === "handlers");
  if ((statusChange || handlerChange) && requirement.groupChatId) {
    plans.push({
      channel: "chat",
      targetId: requirement.groupChatId,
      kind: "status-group",
      card: statusChange ? buildStatusGroupCard({
        config, requirement, iterationNames, actor, statusChange
      }) : buildChangeCard({config, requirement, iterationNames, actor, changes:[handlerChange]})
    });
  }

  return plans;
}

export function validateNotificationCard(card) {
  if (card?.schema !== "2.0") throw new Error("通知卡片必须使用 Card 2.0");
  if (card?.config?.width_mode !== "default") throw new Error("通知卡片宽度必须为 default");
  if (!card?.header?.title?.content || !card?.header?.icon?.token) {
    throw new Error("通知卡片缺少标题或图标");
  }
  const elements = card?.body?.elements;
  if (!Array.isArray(elements) || elements.length < 4 || elements.length > 5) {
    throw new Error("通知卡片视觉块数量必须为 4 到 5");
  }
  const columnSets = elements.filter((item) => item.tag === "column_set");
  if (!columnSets.length || columnSets.some((item) =>
    !Array.isArray(item.columns) || item.columns.some((column) => column.tag !== "column")
  )) {
    throw new Error("通知卡片分组结构无效");
  }
  const buttons = elements.filter((item) => item.tag === "button");
  if (buttons.length !== 1
    || buttons[0].type !== "primary_filled"
    || buttons[0].size !== "small"
    || buttons[0].width !== "fill"
    || !buttons[0].behaviors?.some((item) => item.type === "open_url" && item.default_url)) {
    throw new Error("通知卡片必须有且只有一个查看需求按钮");
  }
  const serializedBody = JSON.stringify(card.body);
  if (serializedBody.includes("background_style") || serializedBody.includes("<font color=")) {
    throw new Error("通知卡片只允许顶部 Header 使用状态主题色");
  }
  if (card.body.padding !== "8px 12px 12px 12px"
    || card.body.vertical_spacing !== "8px"
    || columnSets.some((item) => item.columns.some((column) => column.padding !== "4px 8px"))) {
    throw new Error("通知卡片正文必须使用紧凑间距");
  }
  return true;
}
