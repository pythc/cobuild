#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.FEISHU_ITERATION_BOT_CONFIG || path.join(projectRoot, "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const args = process.argv.slice(2);
const mode = ["disabled", "test_only", "live"].includes(config.notifications?.mode)
  ? config.notifications.mode
  : "disabled";

const READ_ONLY_IM_COMMANDS = new Set([
  "+chats-get",
  "+chats-list",
  "+chats-search",
  "+members-get",
  "+members-list",
  "+messages-get",
  "+messages-list",
  "+messages-search",
  "+messages-read-users",
  "+messages-read-users-list"
]);

function isolationViolation(argv) {
  if (config.storage === 'makit' && ['base', 'raw', 'api', 'openapi'].includes(argv[0])) {
    return '旧飞书表接口已停用，请通过 Makit 的业务工具操作需求。';
  }
  if (mode === "live" || argv.includes("--help") || argv.includes("-h")) return "";
  const [domain = "", command = ""] = argv.filter((item) => !item.startsWith("--"));
  if (["raw", "api", "openapi"].includes(domain)) {
    return "通知隔离期不允许 Agent 直接调用原生 API；请使用项目统一工具。";
  }
  if (domain === "im" && !READ_ONLY_IM_COMMANDS.has(command)) {
    return "通知隔离期只允许 Agent 读取会话；发送消息、建群和修改群成员必须经过项目统一发送器。";
  }
  return "";
}

const violation = isolationViolation(args);
if (violation) {
  if (args.includes("--format") && args.includes("json")) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "NOTIFICATION_ISOLATED", message: violation } })}\n`);
  } else {
    process.stderr.write(`${violation}\n`);
  }
  process.exitCode = 23;
} else {
  const binary = config.runtime?.larkCliPath || "/opt/homebrew/bin/lark-cli";
  const child = spawn(binary, args, { env: process.env, stdio: "inherit" });
  child.on("error", (error) => {
    process.stderr.write(`无法启动 lark-cli：${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
  });
}
