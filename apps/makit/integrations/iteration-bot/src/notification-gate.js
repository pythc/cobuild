const NOTIFICATION_MODES = new Set(["disabled", "test_only", "live"]);

function notificationConfig(config) {
  const notifications = config?.notifications || {};
  const mode = NOTIFICATION_MODES.has(notifications.mode)
    ? notifications.mode
    : "disabled";
  return {
    mode,
    allowedChatIds: new Set(notifications.allowedChatIds || []),
    allowedUserOpenIds: new Set(notifications.allowedUserOpenIds || [])
  };
}

export function notificationDecision(config, target = {}, context = {}) {
  const policy = notificationConfig(config);
  if (config?.interaction?.enabled === false && context.purpose === "agent-reply") {
    return { allowed: false, mode: policy.mode, reason: "automatic replies disabled" };
  }
  if (policy.mode === "live") {
    return { allowed: true, mode: policy.mode, reason: "live mode" };
  }
  if (policy.mode === "disabled") {
    return { allowed: false, mode: policy.mode, reason: "notifications disabled" };
  }

  if (target.userId && policy.allowedUserOpenIds.has(target.userId)) {
    return { allowed: true, mode: policy.mode, reason: "allowed test user" };
  }
  if (target.chatId && policy.allowedChatIds.has(target.chatId)) {
    return { allowed: true, mode: policy.mode, reason: "allowed test chat" };
  }
  if (
    target.chatId
    && context.requestedByUserId
    && policy.allowedUserOpenIds.has(context.requestedByUserId)
    && context.purpose === "agent-reply"
  ) {
    return { allowed: true, mode: policy.mode, reason: "owner conversation reply" };
  }
  return { allowed: false, mode: policy.mode, reason: "target is outside test allowlist" };
}

export function createNotificationGateway({ config, cli, log = () => {}, enqueueDelivery }) {
  const deliveryWindows = new Map();
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;

  function ingest(target, payload, key, context) {
    if (process.env.WORKFLOW_DELIVERY_OWNER !== 'managed_bot' || context.source === 'managed_deliveries' || !context.eventId) return null;
    if (!enqueueDelivery) throw new Error('Managed workflow ledger is not configured');
    const policy = notificationDecision(config, target, context);
    return enqueueDelivery({eventId:context.eventId, requirementId:context.requirementId,
      kind:context.purpose || 'workflow', channel:target.chatId ? 'feishu_group' : 'feishu_private',
      targetId:target.chatId || target.userId, targetName:context.targetName, payload, localAllowed:policy.allowed});
  }

  function safetyDecision(context = {}) {
    const settings = config?.notifications || {};
    const currentTime = Date.now();
    if (circuitOpenUntil > currentTime) {
      return {
        allowed: false,
        reason: `notification circuit open until ${new Date(circuitOpenUntil).toISOString()}`
      };
    }
    const category = context.purpose === "agent-reply" ? "agent" : "workflow";
    const limit = category === "agent"
      ? Number(settings.maxAgentRepliesPerMinute || 60)
      : Number(settings.maxWorkflowDeliveriesPerMinute || 20);
    const cutoff = currentTime - 60_000;
    const recent = (deliveryWindows.get(category) || [])
      .filter((timestamp) => timestamp >= cutoff);
    deliveryWindows.set(category, recent);
    if (recent.length >= limit) {
      return {
        allowed: false,
        reason: `${category} delivery budget exceeded (${recent.length}/${limit} per minute)`
      };
    }
    return { allowed: true, category, currentTime };
  }

  async function dispatch(target, args, context = {}) {
    const decision = notificationDecision(config, target, context);
    if (!decision.allowed) {
      log("info", "[notification] blocked", {
        mode: decision.mode,
        reason: decision.reason,
        purpose: context.purpose || "unspecified",
        target: target.userId ? "user" : "chat"
      });
      return {
        ok: true,
        delivered: false,
        blocked: true,
        mode: decision.mode,
        reason: decision.reason
      };
    }
    const safety = safetyDecision(context);
    if (!safety.allowed) {
      log("error", "[notification] blocked by safety guard", {
        mode: decision.mode,
        reason: safety.reason,
        purpose: context.purpose || "unspecified",
        target: target.userId ? "user" : "chat"
      });
      return {
        ok: true,
        delivered: false,
        blocked: true,
        safetyBlocked: true,
        mode: decision.mode,
        reason: safety.reason
      };
    }
    try {
      const response = await cli.json(args);
      const recent = deliveryWindows.get(safety.category) || [];
      recent.push(safety.currentTime);
      deliveryWindows.set(safety.category, recent);
      consecutiveFailures = 0;
      return {
        ok: true,
        delivered: true,
        blocked: false,
        safetyBlocked: false,
        mode: decision.mode,
        response
      };
    } catch (error) {
      consecutiveFailures += 1;
      const threshold = Number(
        config?.notifications?.maxConsecutiveFailures || 3
      );
      if (consecutiveFailures >= threshold) {
        const breakSeconds = Number(
          config?.notifications?.circuitBreakSeconds || 120
        );
        circuitOpenUntil = Date.now() + breakSeconds * 1000;
        log("error", "[notification] circuit opened", {
          consecutiveFailures,
          breakSeconds
        });
      }
      throw error;
    }
  }

  async function sendMarkdown(chatId, markdown, key, context = {}) {
    const queued = ingest({chatId}, {type:'post',receiveIdType:'chat_id',content:{zh_cn:{title:'需求协作更新',
      content:[[{tag:'text',text:markdown}], ...(context.platformUrl ? [[{tag:'a',text:'查看需求',href:context.platformUrl}]] : [])]}}}, key, context);
    if (queued) return queued;
    return dispatch(
      { chatId },
      [
        "im", "+messages-send",
        "--as", config.identities.messages,
        "--chat-id", chatId,
        "--markdown", markdown,
        "--idempotency-key", key.slice(0, 50)
      ],
      context
    );
  }

  async function sendCard(target, card, key, context = {}) {
    const queued = ingest(target, {type:'interactive',receiveIdType:target.chatId?'chat_id':'open_id',content:card}, key, context);
    if (queued) return queued;
    const destination = target?.chatId
      ? ["--chat-id", target.chatId]
      : target?.userId
        ? ["--user-id", target.userId]
        : null;
    if (!destination) throw new Error("发送卡片时缺少 chat_id 或 user_id");
    return dispatch(
      target,
      [
        "im", "+messages-send",
        "--as", config.identities.messages,
        ...destination,
        "--msg-type", "interactive",
        "--content", JSON.stringify(card),
        "--idempotency-key", key.slice(0, 50)
      ],
      context
    );
  }

  async function sendPost(target, content, key, context = {}) {
    const destination = target?.chatId ? ['--chat-id', target.chatId] : target?.userId ? ['--user-id', target.userId] : null;
    if (!destination) throw new Error('发送消息时缺少接收对象');
    return dispatch(target, ['im', '+messages-send', '--as', config.identities.messages, ...destination,
      '--msg-type', 'post', '--content', JSON.stringify(content), '--idempotency-key', key.slice(0, 50)], context);
  }

  return { sendMarkdown, sendCard, sendPost };
}
