function recordEnvelope(response) {
  const candidates = [response?.data, response?.data?.data, response];
  return candidates.find((item) =>
    item && Array.isArray(item.fields) && Array.isArray(item.data)
  ) || {};
}

function recordEnvelopeToObjects(response) {
  const data = recordEnvelope(response);
  const fields = data.fields || [];
  const rows = data.data || [];
  const ids = data.record_id_list || [];
  return rows.map((values, index) => ({
    recordId: ids[index],
    fields: Object.fromEntries(fields.map((name, fieldIndex) => [name, values[fieldIndex]]))
  }));
}

function valueText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 1 && typeof value[0] === "string") return value[0];
    return value.map(valueText).filter(Boolean).join("、");
  }
  return value.text || value.name || value.id || "";
}

function linkedIds(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean);
}

function people(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    id: item?.id || item?.open_id || "",
    name: item?.name || item?.text || ""
  })).filter((item) => item.id);
}

function textList(value) {
  if (value == null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(valueText).filter(Boolean);
}

function timestampValue(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 10_000_000_000) return numeric;
  const parsed = Date.parse(String(value).replace(" ", "T"));
  return Number.isNaN(parsed) ? null : parsed;
}

function urlValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return urlValue(value[0]);
  return value.link || value.url || value.href || "";
}

function requirementFromRecord(item) {
  const updatedAt = item.fields["更新时间"] || null;
  const recentOperatorAt = item.fields["最近操作时间"] || null;
  const recentOperator = people(item.fields["最近操作人"])[0] || null;
  const updatedTimestamp = timestampValue(updatedAt);
  const recentOperatorTimestamp = timestampValue(recentOperatorAt);
  const recentOperatorMatchesUpdate = Boolean(
    recentOperator
    && recentOperatorTimestamp
    && updatedTimestamp
    && Math.abs(updatedTimestamp - recentOperatorTimestamp) <= 5 * 60 * 1000
  );
  return {
    recordId: item.recordId,
    notificationMarker: valueText(item.fields["平台操作标识"]),
    code: valueText(item.fields["需求编号"]),
    title: valueText(item.fields["需求"]) || "未命名需求",
    type: valueText(item.fields["需求类型"]),
    source: valueText(item.fields["需求来源"]),
    tags: textList(item.fields["需求标签"]),
    status: valueText(item.fields["状态"]) || "未设置",
    priority: valueText(item.fields["优先级"]) || "未设置",
    project: valueText(item.fields["项目"]),
    introduction: valueText(item.fields["需求介绍"]),
    acceptanceCriteria: valueText(item.fields["验收标准"]),
    selfTestReport: valueText(item.fields["自测报告"]),
    iterationIds: linkedIds(item.fields["所属迭代"]),
    handlers: people(item.fields["当前处理人"]),
    developers: people(item.fields["研发人员"]),
    testers: people(item.fields["测试人员"]),
    foOwners: people(item.fields["FO"]),
    productOwners: people(item.fields["产品人员"]),
    proposers: people(item.fields["提出人"]),
    followers: people(item.fields["关注人"]),
    releaseOwners: people(item.fields["发布负责人"]),
    startDate: item.fields["开始时间"] || null,
    deadline: item.fields["截止时间"] || null,
    developmentStart: item.fields["开发预计启动时间"] || null,
    developmentEnd: item.fields["开发预计结束时间"] || null,
    testDate: item.fields["预计提测时间"] || null,
    actualStart: item.fields["实际开始时间"] || null,
    actualTest: item.fields["实际提测时间"] || null,
    actualRelease: item.fields["实际发布时间"] || null,
    effort: item.fields["工作量"] == null || item.fields["工作量"] === ""
      ? null
      : Number(item.fields["工作量"]),
    blocked: item.fields["是否阻塞"] === true,
    blocker: valueText(item.fields["阻塞原因"]),
    latestProgress: valueText(item.fields["最新进展"]),
    updatedAt,
    recentOperator,
    recentOperatorName: valueText(item.fields["最近操作人名称"]),
    recentOperatorAt,
    modifiedBy: recentOperatorMatchesUpdate
      ? {
          ...recentOperator,
          name: valueText(item.fields["最近操作人名称"]) || recentOperator.name
        }
      : people(item.fields["最后修改人"])[0] || null,
    groupChat: item.fields["需求群聊"] || null,
    groupChatId: valueText(item.fields["需求群ID"]),
    groupLink: urlValue(item.fields["需求群链接"]),
    groupStatus: valueText(item.fields["拉群状态"]) || "未创建",
    groupCreatedAt: item.fields["拉群时间"] || null,
    groupMembersSyncedAt: item.fields["群成员同步时间"] || null,
    notificationVersion: valueText(item.fields["最近通知版本"]),
    notificationAt: item.fields["最近通知时间"] || null,
    notificationSummary: valueText(item.fields["最近通知摘要"]),
    rawFields: item.fields
  };
}

function iterationQueryKey(value) {
  return valueText(value)
    .trim()
    .toLowerCase()
    .replace(/[，,]\s*(?:发布(?:时间|日期)?|截止(?:时间|日期)?)\s*(?:\d{4}年)?\d{1,2}月\d{1,2}日\s*$/, "")
    .trim();
}

function dateTimeNow(timeZone) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export function createBaseStore(config, cli) {
  const identity = config.identities.base;
  const common = ["--base-token", config.baseToken, "--as", identity];

  async function listAll(tableId, fieldNames = []) {
    const records = [];
    let offset = 0;
    while (true) {
      const args = [
        "base", "+record-list",
        ...common,
        "--table-id", tableId,
        "--limit", "200",
        "--offset", String(offset)
      ];
      for (const field of fieldNames) args.push("--field-id", field);
      const response = await cli.json(args);
      const envelope = recordEnvelope(response);
      records.push(...recordEnvelopeToObjects(response));
      if (!envelope.has_more) break;
      offset += envelope.data?.length || 200;
    }
    return records;
  }

  async function writeRecord(tableId, fields, recordId = null) {
    const args = [
      "base", "+record-upsert",
      ...common,
      "--table-id", tableId,
      "--json", JSON.stringify(fields)
    ];
    if (recordId) args.push("--record-id", recordId);
    return cli.json(args);
  }

  async function listIterations() {
    return listAll(config.tables.iterations, [
      "迭代名称", "开始时间", "结束时间", "状态", "负责人", "允许群绑定", "迭代目标",
      "需求评审时间", "开发启动时间", "提测时间", "发布时间"
    ]);
  }

  async function getIterationById(recordId) {
    if (!recordId) return null;
    const iterations = await listIterations();
    return iterations.find((item) => item.recordId === recordId) || null;
  }

  async function resolveIteration(query) {
    const raw = valueText(query).trim().toLowerCase();
    const semantic = iterationQueryKey(query);
    const iterations = await listIterations();
    // Natural-language commands often append release dates. Prefer the
    // canonical iteration name when both a canonical and a legacy full-text
    // record exist.
    const canonical = semantic !== raw
      ? iterations.find((item) => valueText(item.fields["迭代名称"]).trim().toLowerCase() === semantic)
      : null;
    if (canonical) return { match: canonical, candidates: [canonical] };
    const exact = iterations.find((item) => valueText(item.fields["迭代名称"]).trim().toLowerCase() === raw);
    if (exact) return { match: exact, candidates: [exact] };
    const candidates = iterations.filter((item) =>
      iterationQueryKey(item.fields["迭代名称"]).includes(semantic)
    );
    return { match: candidates.length === 1 ? candidates[0] : null, candidates };
  }

  async function createIteration({ name, startDate, endDate, ownerOpenId }) {
    const existing = await resolveIteration(name);
    if (existing.match) throw new Error(`迭代“${name}”已存在`);
    const fields = {
      "迭代名称": name,
      "状态": "规划中",
      "允许群绑定": true
    };
    if (startDate) fields["开始时间"] = `${startDate} 00:00:00`;
    if (endDate) fields["结束时间"] = `${endDate} 23:59:59`;
    if (ownerOpenId) fields["负责人"] = [{ id: ownerOpenId }];
    await writeRecord(config.tables.iterations, fields);
    const verified = await resolveIteration(name);
    if (!verified.match) throw new Error(`迭代“${name}”写入后未能回读，请稍后重试`);
    return verified.match;
  }

  async function deleteIteration(iteration) {
    const name = valueText(iteration.fields["迭代名称"]);
    const [requirements, bindings] = await Promise.all([
      listRequirements(iteration),
      listBindings()
    ]);
    const affectedBindings = bindings.filter((item) =>
      linkedIds(item.fields["绑定迭代"]).includes(iteration.recordId)
      || valueText(item.fields["迭代名称"]) === name
    );

    await cli.json([
      "base", "+record-delete",
      ...common,
      "--table-id", config.tables.iterations,
      "--record-id", iteration.recordId,
      "--yes"
    ]);

    for (const binding of affectedBindings) {
      await writeRecord(config.tables.bindings, {
        "是否启用": false,
        "绑定迭代": null,
        "迭代名称": ""
      }, binding.recordId);
    }

    const remaining = await listIterations();
    if (remaining.some((item) => item.recordId === iteration.recordId)) {
      throw new Error(`迭代“${name}”删除后仍能回读，请稍后重试`);
    }
    return {
      requirementCount: requirements.length,
      disabledBindingCount: affectedBindings.length
    };
  }

  async function listBindings() {
    return listAll(config.tables.bindings, [
      "群聊ID", "群名称", "绑定迭代", "迭代名称", "是否启用", "绑定人",
      "绑定时间", "发布频率", "发布时间", "发布星期", "催办方式"
    ]);
  }

  async function listBindingsForIteration(iteration) {
    if (!iteration) return [];
    const name = valueText(iteration.fields["迭代名称"]);
    return (await listBindings()).filter((item) =>
      item.fields["是否启用"] === true
      && (
        linkedIds(item.fields["绑定迭代"]).includes(iteration.recordId)
        || valueText(item.fields["迭代名称"]) === name
      )
    );
  }

  async function getBinding(chatId) {
    const bindings = await listBindings();
    return bindings.find((item) => valueText(item.fields["群聊ID"]) === chatId) || null;
  }

  async function bindChat({ chatId, chatName, iteration, binderOpenId }) {
    const existing = await getBinding(chatId);
    const name = valueText(iteration.fields["迭代名称"]);
    const fields = {
      "群聊ID": chatId,
      "群名称": chatName || chatId,
      "绑定迭代": [{ id: iteration.recordId }],
      "迭代名称": name,
      "是否启用": true,
      "绑定人": [{ id: binderOpenId }],
      "绑定时间": dateTimeNow(config.runtime.timezone),
      "发布频率": existing ? valueText(existing.fields["发布频率"]) || "仅手动" : "仅手动",
      "发布时间": existing ? valueText(existing.fields["发布时间"]) || "09:30" : "09:30",
      "发布星期": existing ? valueText(existing.fields["发布星期"]) || "周一" : "周一",
      "催办方式": existing ? valueText(existing.fields["催办方式"]) || "群内@负责人" : "群内@负责人"
    };
    await writeRecord(config.tables.bindings, fields, existing?.recordId);
    const verified = await getBinding(chatId);
    if (!verified || !verified.fields["是否启用"]) {
      throw new Error("群聊绑定写入后未能回读，请稍后重试");
    }
    if (!linkedIds(verified.fields["绑定迭代"]).includes(iteration.recordId)) {
      throw new Error("群聊绑定已写入，但关联迭代校验失败");
    }
    return verified;
  }

  async function unbindChat(chatId) {
    const existing = await getBinding(chatId);
    if (!existing) return false;
    await writeRecord(config.tables.bindings, {
      "是否启用": false,
      "绑定迭代": null,
      "迭代名称": ""
    }, existing.recordId);
    return true;
  }

  async function updateSchedule(chatId, schedule) {
    const existing = await getBinding(chatId);
    if (!existing || !existing.fields["是否启用"]) throw new Error("当前群尚未绑定迭代");
    await writeRecord(config.tables.bindings, schedule, existing.recordId);
    return true;
  }

  async function getIterationForBinding(binding) {
    const ids = linkedIds(binding?.fields?.["绑定迭代"]);
    const name = valueText(binding?.fields?.["迭代名称"]);
    const iterations = await listIterations();
    return iterations.find((item) => ids.includes(item.recordId))
      || iterations.find((item) => valueText(item.fields["迭代名称"]) === name)
      || null;
  }

  async function listRequirements(iteration) {
    return (await listAllRequirements())
      .filter((item) => item.iterationIds.includes(iteration.recordId));
  }

  async function listAllRequirements() {
    const rows = await listAll(config.tables.requirements, [
      "需求编号", "需求", "需求类型", "需求来源", "需求标签", "需求介绍", "验收标准", "自测报告",
      "所属迭代", "状态", "优先级", "项目", "提出人", "当前处理人", "产品人员",
      "研发人员", "测试人员", "关注人", "发布负责人", "开始时间", "截止时间",
      "开发预计启动时间", "开发预计结束时间", "预计提测时间", "实际开始时间",
      "实际提测时间", "实际发布时间", "工作量", "是否阻塞", "阻塞原因", "最新进展",
      "更新时间", "最后修改人", "最近操作人", "最近操作人名称", "最近操作时间",
      "需求群聊", "需求群ID", "需求群链接", "拉群状态", "拉群时间",
      "群成员同步时间", "最近通知版本", "最近通知时间", "最近通知摘要"
    ]);
    return rows.map(requirementFromRecord);
  }

  async function getRequirementById(recordId) {
    if (!recordId) return null;
    return (await listAllRequirements()).find((item) => item.recordId === recordId) || null;
  }

  async function updateRequirement(recordId, fields) {
    if (!recordId) throw new Error("缺少需求 record_id");
    await writeRecord(config.tables.requirements, fields, recordId);
    return true;
  }

  async function listCollaborationEvents() {
    if (!config.tables.collaboration) return [];
    const rows = await listAll(config.tables.collaboration, [
      "事件键", "事件类型", "需求", "迭代", "目标群", "状态", "触发来源",
      "变更字段", "变更前", "变更后", "尝试次数", "下次重试时间",
      "错误信息", "负载摘要", "处理时间", "创建时间", "更新时间"
    ]);
    return rows.map((item) => ({
      ...item,
      eventKey: valueText(item.fields["事件键"]),
      type: valueText(item.fields["事件类型"]),
      requirementIds: linkedIds(item.fields["需求"]),
      iterationIds: linkedIds(item.fields["迭代"]),
      targetChatIds: linkedIds(item.fields["目标群"]),
      status: valueText(item.fields["状态"]) || "待处理",
      source: valueText(item.fields["触发来源"]),
      attempts: Number(item.fields["尝试次数"] || 0),
      retryAt: item.fields["下次重试时间"] || null
    }));
  }

  async function findCollaborationEvent(eventKey) {
    if (!eventKey) return null;
    return (await listCollaborationEvents()).find((item) => item.eventKey === eventKey) || null;
  }

  async function createCollaborationEvent(eventKey, fields) {
    if (!config.tables.collaboration) throw new Error("未配置协作事件表");
    const existing = await findCollaborationEvent(eventKey);
    if (existing) return existing;
    await writeRecord(config.tables.collaboration, {
      "事件键": eventKey,
      ...fields
    });
    const created = await findCollaborationEvent(eventKey);
    if (!created) throw new Error(`协作事件“${eventKey}”写入后未能回读`);
    return created;
  }

  async function updateCollaborationEvent(recordId, fields) {
    if (!config.tables.collaboration) throw new Error("未配置协作事件表");
    await writeRecord(config.tables.collaboration, fields, recordId);
    return true;
  }

  async function listManagementOperations() {
    if (!config.tables.operations) return [];
    const rows = await listAll(config.tables.operations, [
      "操作项", "迭代", "一键收集进展", "一键催办", "执行状态",
      "最后操作", "操作时间", "执行结果", "更新时间", "最后修改人"
    ]);
    return rows.map((item) => ({
      ...item,
      iterationIds: linkedIds(item.fields["迭代"]),
      updatedByIds: people(item.fields["最后修改人"]).map((person) => person.id),
      collectProgress: item.fields["一键收集进展"] === true,
      remind: item.fields["一键催办"] === true
    }));
  }

  async function updateManagementOperation(recordId, fields) {
    if (!config.tables.operations) throw new Error("未配置迭代操作中心");
    await writeRecord(config.tables.operations, fields, recordId);
    return true;
  }

  return {
    valueText,
    listIterations,
    getIterationById,
    resolveIteration,
    createIteration,
    deleteIteration,
    listBindings,
    listBindingsForIteration,
    getBinding,
    bindChat,
    unbindChat,
    updateSchedule,
    getIterationForBinding,
    listAllRequirements,
    getRequirementById,
    updateRequirement,
    listRequirements,
    listCollaborationEvents,
    findCollaborationEvent,
    createCollaborationEvent,
    updateCollaborationEvent,
    listManagementOperations,
    updateManagementOperation
  };
}
