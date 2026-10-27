import {
  classifyMilestoneOverdue,
  formatMilestoneReminder,
  formatProgressCollection,
  formatReminder,
  selectProgressTargets,
  selectReminderTargets
} from "./reporter.js";

function dateTimeText(date, timeZone) {
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

function operationLabel(collectProgress, remind) {
  if (collectProgress && remind) return "收集进展+催办";
  return collectProgress ? "收集进展" : "催办";
}

function operationErrorText(error) {
  return String(error?.message || error || "未知错误").slice(0, 500);
}

function messageKey(operationId, actionIndex, chatIndex, now) {
  return `manage-${operationId}-${now.getTime()}-${actionIndex}-${chatIndex}`.slice(0, 50);
}

export async function deliverManagementAction({
  config,
  base,
  sendMarkdown,
  iteration,
  collectProgress = false,
  remind = false,
  operationId = "direct",
  now = new Date()
}) {
  if (!collectProgress && !remind) throw new Error("没有待执行的管理操作");
  if (!iteration) throw new Error("未找到操作对应的迭代");

  const [requirements, bindings] = await Promise.all([
    base.listRequirements(iteration),
    base.listBindingsForIteration(iteration)
  ]);
  const chats = bindings
    .map((item) => base.valueText(item.fields["群聊ID"]))
    .filter(Boolean);
  if (!chats.length) {
    throw new Error(`迭代“${base.valueText(iteration.fields["迭代名称"])}”没有启用的群聊绑定`);
  }

  const messages = [];
  const targetIds = new Set();
  if (collectProgress) {
    const targets = selectProgressTargets(requirements, now.getTime());
    for (const item of targets) targetIds.add(item.recordId);
    if (targets.length) {
      messages.push(formatProgressCollection(iteration, requirements, config, {
        now: now.getTime()
      }));
    }
  }
  if (remind) {
    const milestoneGroups = classifyMilestoneOverdue(iteration, requirements, now.getTime());
    const milestoneIds = new Set(
      milestoneGroups.flatMap((group) => group.items.map((item) => item.recordId))
    );
    for (const id of milestoneIds) targetIds.add(id);
    if (milestoneGroups.length) {
      messages.push(formatMilestoneReminder(iteration, requirements, {}, {
        now: now.getTime(),
        timezone: config.runtime.timezone,
        config
      }));
    }
    const generalTargets = selectReminderTargets(requirements, now.getTime())
      .filter((item) => !milestoneIds.has(item.recordId));
    for (const item of generalTargets) targetIds.add(item.recordId);
    if (generalTargets.length) {
      messages.push(formatReminder(iteration, generalTargets, config, {
        now: now.getTime()
      }));
    }
  }

  let sentMessages = 0;
  let blockedMessages = 0;
  for (let chatIndex = 0; chatIndex < chats.length; chatIndex += 1) {
    for (let actionIndex = 0; actionIndex < messages.length; actionIndex += 1) {
      const delivery = await sendMarkdown(
        chats[chatIndex],
        messages[actionIndex],
        messageKey(operationId, actionIndex, chatIndex, now),
        { purpose: collectProgress ? "progress-collection" : "iteration-reminder" }
      );
      if (delivery?.blocked) blockedMessages += 1;
      else sentMessages += 1;
    }
  }

  return {
    iterationName: base.valueText(iteration.fields["迭代名称"]),
    requirementCount: requirements.length,
    targetRequirementCount: targetIds.size,
    chatCount: chats.length,
    sentMessages,
    blockedMessages
  };
}

export function createManagementController({
  config,
  base,
  sendMarkdown,
  log = () => {},
  now = () => new Date()
}) {
  let running = false;

  function canRunOperation(operation) {
    if (config.authorization?.ownerOnly !== true) return true;
    const owners = new Set(config.authorization.ownerOpenIds || []);
    return operation.updatedByIds?.some((id) => owners.has(id)) === true;
  }

  async function rejectUnauthorizedOperation(operation) {
    await base.updateManagementOperation(operation.recordId, {
      "一键收集进展": false,
      "一键催办": false,
      "执行状态": "失败",
      "执行结果": "当前账号无权触发管理操作"
    });
    log("info", `[management] rejected unauthorized operation=${operation.recordId}`);
    return { ok: false, error: "当前账号无权触发管理操作" };
  }

  async function markInterruptedOperations(operations, currentTime) {
    const timeoutMs = (config.runtime.managementProcessingTimeoutSeconds || 300) * 1000;
    for (const operation of operations) {
      if (operation.collectProgress || operation.remind) continue;
      if (base.valueText(operation.fields["执行状态"]) !== "处理中") continue;
      const updatedAt = Date.parse(String(operation.fields["更新时间"] || "").replace(" ", "T"));
      if (Number.isNaN(updatedAt) || currentTime.getTime() - updatedAt < timeoutMs) continue;
      await base.updateManagementOperation(operation.recordId, {
        "执行状态": "失败",
        "执行结果": "上次执行被服务重启中断，请重新勾选对应操作"
      });
    }
  }

  async function processOperation(operation) {
    const collectProgress = operation.collectProgress;
    const remind = operation.remind;
    const label = operationLabel(collectProgress, remind);
    const currentTime = now();
    await base.updateManagementOperation(operation.recordId, {
      "一键收集进展": false,
      "一键催办": false,
      "执行状态": "处理中",
      "最后操作": label,
      "操作时间": dateTimeText(currentTime, config.runtime.timezone),
      "执行结果": "正在执行"
    });

    try {
      const iteration = await base.getIterationById(operation.iterationIds[0]);
      const result = await deliverManagementAction({
        config,
        base,
        sendMarkdown,
        iteration,
        collectProgress,
        remind,
        operationId: operation.recordId,
        now: currentTime
      });
      const resultText = result.targetRequirementCount
        ? result.sentMessages
          ? `已发送 ${result.sentMessages} 条消息，覆盖 ${result.targetRequirementCount} 项符合条件的需求；隔离 ${result.blockedMessages} 条`
          : `通知隔离期已拦截 ${result.blockedMessages} 条群消息，未向外发送；涉及 ${result.targetRequirementCount} 项需求`
        : "没有符合条件的风险或待更新需求，未发送群消息";
      await base.updateManagementOperation(operation.recordId, {
        "执行状态": "已完成",
        "执行结果": resultText
      });
      log("info", `[management] ${label} completed iteration=${result.iterationName} ${resultText}`);
      return { ok: true, ...result };
    } catch (error) {
      const reason = operationErrorText(error);
      await base.updateManagementOperation(operation.recordId, {
        "执行状态": "失败",
        "执行结果": reason
      });
      log("error", `[management] ${label} failed operation=${operation.recordId}`, reason);
      return { ok: false, error: reason };
    }
  }

  async function runPendingOperations() {
    if (running) return [];
    running = true;
    try {
      const currentTime = now();
      const operations = await base.listManagementOperations();
      await markInterruptedOperations(operations, currentTime);
      const results = [];
      for (const operation of operations) {
        if (!operation.collectProgress && !operation.remind) continue;
        if (!canRunOperation(operation)) {
          results.push(await rejectUnauthorizedOperation(operation));
          continue;
        }
        results.push(await processOperation(operation));
      }
      return results;
    } finally {
      running = false;
    }
  }

  return { runPendingOperations };
}
