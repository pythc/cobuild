import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBaseStore } from "./base.js";
import { createCollaborationController } from "./collaboration.js";
import { createLarkCli } from "./lark-cli.js";
import { createNotificationGateway } from "./notification-gate.js";
import { createStateStore } from "./state.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.FEISHU_ITERATION_BOT_CONFIG || path.join(projectRoot, "config.json");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function actionType(value) {
  const action = String(value || "").trim().toLowerCase();
  if (["create", "创建", "拉群"].includes(action)) return "创建需求群";
  if (["sync", "同步", "同步成员"].includes(action)) return "同步群成员";
  if (["open", "打开", "查看"].includes(action)) return "打开需求群";
  throw new Error("action 仅支持 create、sync 或 open");
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const cli = createLarkCli(config);
const base = createBaseStore(config, cli);
const state = createStateStore(projectRoot, {
  maxConversationTurns: config.runtime.conversationMaxTurns,
  maxConversationChats: config.runtime.conversationMaxChats,
  conversationTtlDays: config.runtime.conversationTtlDays
});
await state.load();

const recordId = argument("--record-id");
const title = argument("--requirement");
const iterationName = argument("--iteration");
const type = actionType(argument("--action"));
let requirements = await base.listAllRequirements();
if (recordId) {
  requirements = requirements.filter((item) => item.recordId === recordId);
} else if (title) {
  const exact = requirements.filter((item) => item.title.trim() === title.trim());
  requirements = exact.length ? exact : requirements.filter((item) => item.title.includes(title));
} else {
  throw new Error("缺少 --record-id 或 --requirement");
}

if (iterationName) {
  const resolution = await base.resolveIteration(iterationName);
  if (!resolution.match) throw new Error(`未唯一匹配到迭代“${iterationName}”`);
  requirements = requirements.filter((item) => item.iterationIds.includes(resolution.match.recordId));
}
if (!requirements.length) throw new Error("未找到目标需求");
if (requirements.length > 1) {
  throw new Error(`匹配到多个需求：${requirements.map((item) => item.title).join("、")}`);
}
const [requirement] = requirements;
if (type === "打开需求群") {
  if (!requirement.groupChatId) throw new Error(`需求“${requirement.title}”尚未创建需求群`);
  process.stdout.write(
    `需求群：${requirement.groupLink || requirement.groupChatId}\n`
  );
  process.exit(0);
}

const { sendMarkdown } = createNotificationGateway({ config, cli });

const collaboration = createCollaborationController({
  config,
  base,
  state,
  cli,
  sendMarkdown
});
const result = await collaboration.runGroupAction(type, requirement, "Agent");
const current = await base.getRequirementById(requirement.recordId);
const actionText = type === "创建需求群" && result.created === false ? "需求群已存在，成员已同步" : `${type}已完成`;
process.stdout.write(
  `已完成：${actionText}。${current?.groupLink ? `[打开需求群](${current.groupLink})` : `群 ID：${current?.groupChatId || result.chatId}`}\n`
);
