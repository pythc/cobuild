import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBaseStore } from "./base.js";
import { createLarkCli } from "./lark-cli.js";
import { deliverManagementAction } from "./management.js";
import { createNotificationGateway } from "./notification-gate.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.FEISHU_ITERATION_BOT_CONFIG || path.join(projectRoot, "config.json");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function actionFlags(value) {
  const action = String(value || "").trim().toLowerCase();
  if (["collect", "update", "收集进展", "更新"].includes(action)) {
    return { collectProgress: true, remind: false };
  }
  if (["remind", "催办"].includes(action)) {
    return { collectProgress: false, remind: true };
  }
  if (["both", "all", "全部"].includes(action)) {
    return { collectProgress: true, remind: true };
  }
  throw new Error("action 仅支持 collect、remind 或 both");
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const cli = createLarkCli(config);
const base = createBaseStore(config, cli);
const chatId = argument("--chat-id");
const iterationName = argument("--iteration");
const flags = actionFlags(argument("--action"));

let iteration = null;
if (iterationName) {
  const resolution = await base.resolveIteration(iterationName);
  if (!resolution.match) {
    const candidates = resolution.candidates
      .map((item) => base.valueText(item.fields["迭代名称"]))
      .filter(Boolean);
    throw new Error(candidates.length
      ? `迭代名称不唯一：${candidates.join("、")}`
      : `未找到迭代“${iterationName}”`);
  }
  iteration = resolution.match;
} else if (chatId) {
  const binding = await base.getBinding(chatId);
  if (binding?.fields?.["是否启用"]) iteration = await base.getIterationForBinding(binding);
}

if (!iteration) {
  const candidates = (await base.listIterations()).filter((item) =>
    ["规划中", "进行中"].includes(base.valueText(item.fields["状态"]))
  );
  if (candidates.length === 1) [iteration] = candidates;
  else throw new Error("无法唯一确定迭代，请提供 --iteration 或已绑定的 --chat-id");
}

const { sendMarkdown } = createNotificationGateway({ config, cli });

const result = await deliverManagementAction({
  config,
  base,
  sendMarkdown,
  iteration,
  ...flags,
  operationId: `agent-${Date.now()}`
});
process.stdout.write(
  result.sentMessages
    ? `已完成：迭代「${result.iterationName}」已发送 ${result.sentMessages} 条消息，覆盖 ${result.targetRequirementCount} 项需求。\n`
    : `已完成：通知隔离期已拦截 ${result.blockedMessages} 条消息，未向外发送。\n`
);
