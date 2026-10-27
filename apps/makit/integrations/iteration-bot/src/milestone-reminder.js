import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBaseStore } from "./base.js";
import { createLarkCli } from "./lark-cli.js";
import { formatMilestoneReminder } from "./reporter.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.FEISHU_ITERATION_BOT_CONFIG || path.join(projectRoot, "config.json");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const chatId = argument("--chat-id");
if (!chatId) throw new Error("缺少 --chat-id");

const config = JSON.parse(await readFile(configPath, "utf8"));
const cli = createLarkCli(config);
const base = createBaseStore(config, cli);
const binding = await base.getBinding(chatId);
let iteration = binding?.fields?.["是否启用"]
  ? await base.getIterationForBinding(binding)
  : null;
if (!iteration) {
  const candidates = (await base.listIterations()).filter((item) => {
    const status = base.valueText(item.fields["状态"]);
    return item.fields["允许群绑定"] === true && ["规划中", "进行中"].includes(status);
  });
  if (candidates.length === 1) {
    [iteration] = candidates;
  } else if (!candidates.length) {
    throw new Error("当前群没有绑定迭代，也没有可用迭代");
  } else {
    throw new Error("当前群没有绑定迭代，且存在多个可用迭代，请先绑定");
  }
}

const requirements = await base.listRequirements(iteration);
process.stdout.write(`${formatMilestoneReminder(iteration, requirements, {}, {
  config,
  timezone: config.runtime.timezone
})}\n`);
