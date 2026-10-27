import {createDevelopmentOverdue} from './development-overdue.js';
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLarkCli } from "./lark-cli.js";
import { createFeishuAgent } from "./agent.js";
import { createBaseStore } from "./base.js";
import { canInteract } from "./authorization.js";
import { createCollaborationController } from "./collaboration.js";
import { createEventStream } from "./event-stream.js";
import { createManagementController } from "./management.js";
import { createNotificationGateway } from "./notification-gate.js";
import { createManagedDeliveryConsumer } from "./managed-deliveries.js";
import { createStateStore } from "./state.js";
import { formatReport } from "./reporter.js";
import { enforceResponsePolicy, isRequirementRelated, requirementRecordUrl } from "./response-policy.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.FEISHU_ITERATION_BOT_CONFIG || path.join(projectRoot, "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const cli = createLarkCli(config);
const base = createBaseStore(config, cli);
const state = createStateStore(projectRoot, {
  maxConversationTurns: config.runtime.conversationMaxTurns,
  maxConversationChats: config.runtime.conversationMaxChats,
  conversationTtlDays: config.runtime.conversationTtlDays
});
const eventStream = createEventStream(cli);
const feishuAgent = createFeishuAgent(config, projectRoot, cli);
await state.load();

function log(level, message, details = "") {
  const suffix = details ? ` ${typeof details === "string" ? details : JSON.stringify(details)}` : "";
  console[level](`${new Date().toISOString()} ${message}${suffix}`);
}

function eventValue(payload, key) {
  return payload?.[key] ?? payload?.event?.[key] ?? payload?.data?.[key];
}

function senderOpenId(payload) {
  const sender = eventValue(payload, "sender") || {};
  return eventValue(payload, "sender_id")
    || sender?.sender_id?.open_id
    || sender?.open_id
    || sender?.id?.open_id
    || "";
}

function messageText(payload) {
  const content = eventValue(payload, "content");
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || content;
    } catch {
      return content;
    }
  }
  return content?.text || "";
}

function mentionsBot(payload) {
  const mentions = eventValue(payload, "mentions") || [];
  return mentions.some((mention) => {
    const id = mention?.id?.open_id || mention?.id || mention?.open_id || mention?.user_id;
    return id === config.botOpenId;
  });
}

const { sendMarkdown, sendCard, sendPost } = createNotificationGateway({ config, cli, log,
  enqueueDelivery: (input) => managedDeliveries.ingest(input) });
const managedDeliveries = createManagedDeliveryConsumer({ config, sendCard, sendPost, log });
const developmentOverdue = createDevelopmentOverdue({rootDir:projectRoot,config,base,sendPost,log,requirementUrl:r=>requirementRecordUrl(config,r.recordId)});

const management = createManagementController({
  config,
  base,
  sendMarkdown,
  log
});
const collaboration = createCollaborationController({
  reconcileWorkflow: (...args) => managedDeliveries.reconcile(...args),
  config,
  base,
  state,
  cli,
  sendMarkdown,
  sendCard,
  log
});

async function runManagementOperations() {
  try {
    await management.runPendingOperations();
  } catch (error) {
    log("error", "[management] poll failed", error.message);
  }
}

async function runCollaboration() {
  try {
    const result = await collaboration.runOnce();
    // Native Base edits and creations still enter through the existing scanner.
    // In managed mode its notification calls only persist ledger entries.
    const events = result?.scan?.events || 0;
    const processed = result?.processed?.length || 0;
    if (events || processed) {
      log("info", `[collaboration] detected=${events} processed=${processed}`);
    }
  } catch (error) {
    log("error", "[collaboration] poll failed", error.message);
  }
  // Existing queued deliveries must drain even when scanning new events fails.
  if (managedDeliveries.enabled()) {
    try { await managedDeliveries.runOnce(); }
    catch (error) { log("error", "[deliveries] poll failed", error.message); }
  } else {
    try { await developmentOverdue.runOnce(); }
    catch { log("error", "[development-overdue] scan failed; retry later"); }
  }
}

async function requireBinding(chatId) {
  const binding = await base.getBinding(chatId);
  if (!binding || !binding.fields["是否启用"]) {
    throw new Error("当前群还没有绑定迭代。请让管理员发送：`@机器人 绑定到 迭代名称`");
  }
  const iteration = await base.getIterationForBinding(binding);
  if (!iteration) throw new Error("绑定记录中的迭代已不存在，请重新绑定");
  return { binding, iteration };
}

async function reportFor(chatId) {
  const { iteration } = await requireBinding(chatId);
  const requirements = await base.listRequirements(iteration);
  return formatReport(iteration, requirements, config);
}

async function applyResponsePolicy(response, instruction, chatId, chatType) {
  let requirements = [];
  if (isRequirementRelated(instruction)) {
    try {
      const { iteration } = await requireBinding(chatId);
      requirements = await base.listRequirements(iteration);
    } catch (error) {
      log("info", "[response-policy] requirement enrichment skipped", error.message);
    }
  }
  return enforceResponsePolicy(response, instruction, requirements, config, chatType);
}

async function handleEvent(payload) {
  if (config.interaction?.enabled === false) return;
  const messageId = eventValue(payload, "message_id");
  const chatId = eventValue(payload, "chat_id");
  const chatType = eventValue(payload, "chat_type");
  const type = eventValue(payload, "message_type") || eventValue(payload, "msg_type");
  if (!messageId || !chatId || type !== "text") return;
  if (state.hasProcessed(messageId)) return;
  if (chatType === "group" && !mentionsBot(payload)) return;

  const senderId = senderOpenId(payload);
  if (!canInteract(config, senderId)) {
    log("info", `[authorization] ignored sender=${senderId || "unknown"} chat=${chatId}`);
    await state.markProcessed(messageId);
    return;
  }
  const text = messageText(payload);
  let response;
  try {
    response = await feishuAgent.execute(text, {
      chatId,
      chatType,
      senderId,
      conversation: state.getConversation(chatId),
      baseToken: config.baseToken,
      baseUrl: config.baseUrl,
      requirementPlatformUrl: config.requirementPlatformUrl,
      cockpitUrl: config.cockpitUrl,
      dashboardId: config.dashboardId,
      tables: config.tables,
      identities: config.identities,
      notificationMode: config.notifications?.mode || "disabled",
      replyTemplates: config.replyTemplates,
      timezone: config.runtime.timezone,
      now: new Date().toISOString()
    });
    response = await applyResponsePolicy(response, text, chatId, chatType);
  } catch (error) {
    log("error", "[agent] failed", error.message);
    response = (config.replyTemplates?.failed || "处理失败：{reason}")
      .replace("{reason}", error.message);
  }
  await sendMarkdown(chatId, response, `reply-${messageId}`, {
    purpose: "agent-reply",
    requestedByUserId: senderId
  });
  await state.appendConversation(chatId, {
    user: text,
    assistant: response,
    intent: { type: "agent" }
  });
  await state.markProcessed(messageId);
}

const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function zonedParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: config.runtime.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`,
    weekday: weekDays.includes(map.weekday) ? map.weekday : weekDays[now.getDay()]
  };
}

async function runSchedules() {
  try {
    const now = zonedParts();
    for (const binding of await base.listBindings()) {
      if (!binding.fields["是否启用"]) continue;
      const frequency = base.valueText(binding.fields["发布频率"]) || "仅手动";
      if (frequency === "仅手动") continue;
      const publishTime = base.valueText(binding.fields["发布时间"]) || "09:30";
      if (publishTime !== now.time) continue;
      if (frequency === "每周" && base.valueText(binding.fields["发布星期"]) !== now.weekday) continue;
      const chatId = base.valueText(binding.fields["群聊ID"]);
      const key = `${chatId}:${now.date}:${frequency}`;
      if (!chatId || state.scheduledKeySent(key)) continue;
      const markdown = await reportFor(chatId);
      const delivery = await sendMarkdown(
        chatId,
        markdown,
        `schedule-${now.date}-${chatId}`.slice(0, 50),
        { purpose: "scheduled-iteration-report" }
      );
      await state.markScheduled(key);
      log(
        "info",
        delivery?.blocked
          ? `[schedule] blocked by notification gate chat=${chatId}`
          : `[schedule] published chat=${chatId}`
      );
    }
  } catch (error) {
    log("error", "[schedule] failed", error.message);
  }
}

let scheduleTimer;
let managementTimer;
let collaborationTimer;
let backgroundQueue = Promise.resolve();
const backgroundPending = new Set();

function enqueueBackground(name, task) {
  if (backgroundPending.has(name)) return;
  backgroundPending.add(name);
  backgroundQueue = backgroundQueue.catch(() => {}).then(async () => {
    try {
      await task();
    } finally {
      backgroundPending.delete(name);
    }
  });
}

function shutdown(signal) {
  log("info", `[system] received ${signal}, shutting down`);
  clearInterval(scheduleTimer);
  clearInterval(managementTimer);
  clearInterval(collaborationTimer);
  eventStream.stop();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log("info", `[system] starting ${config.appName} (${config.appId})`);
if (config.interaction?.enabled !== false) {
  void eventStream.start(handleEvent).catch((error) => {
    log("error", "[event] stream stopped", error.message);
  });
} else {
  log("info", "[event] automatic replies disabled; business notifications remain enabled");
}
await runSchedules();
await runManagementOperations();
await runCollaboration();
scheduleTimer = setInterval(
  () => enqueueBackground("schedule", runSchedules),
  config.runtime.schedulePollSeconds * 1000
);
managementTimer = setInterval(
  () => enqueueBackground("management", runManagementOperations),
  (config.runtime.managementPollSeconds || 15) * 1000
);
collaborationTimer = setInterval(
  () => enqueueBackground("collaboration", runCollaboration),
  (config.runtime.collaborationPollSeconds || 10) * 1000
);
