import { constants } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const reasoningEfforts = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

async function isExecutable(filePath) {
  if (!filePath || filePath === "codex") return false;
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexPath(
  configuredPath,
  {
    extensionRoot = path.join(process.env.HOME || "", ".codebuddycn", "extensions")
  } = {}
) {
  if (await isExecutable(configuredPath)) return configuredPath;

  const architecture = process.arch === "arm64" ? "aarch64" : process.arch;
  try {
    const extensionNames = (await readdir(extensionRoot))
      .filter((name) => name.startsWith("openai.chatgpt-") && name.includes("-darwin-"))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const extensionName of extensionNames) {
      const candidate = path.join(
        extensionRoot,
        extensionName,
        "bin",
        `macos-${architecture}`,
        "codex"
      );
      if (await isExecutable(candidate)) return candidate;
    }
  } catch {
    // 兼容非 CodeBuddy 环境，交给 PATH 解析。
  }

  return "codex";
}

function runProcess(command, args, { cwd, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        CODEX_HOME: process.env.CODEX_HOME || path.join(process.env.HOME, ".codex")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`大模型理解超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`大模型进程退出码 ${code}：${stderr.trim() || "无错误详情"}`));
    });
    child.stdin.end(input);
  });
}

export function buildCodexArgs(
  config,
  projectRoot,
  outputPath
) {
  const llm = config.llm || {};
  const reasoningEffort = llm.reasoningEffort || "medium";
  if (!reasoningEfforts.has(reasoningEffort)) {
    throw new Error(`不支持的推理力度：${reasoningEffort}`);
  }
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model", llm.model,
    "-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    "--output-last-message", outputPath,
    "-"
  ];
}

export async function invokeCodexAgent(
  config,
  projectRoot,
  prompt,
  {
    tempPrefix = "feishu-direct-agent-"
  } = {}
) {
  const llm = config.llm || {};
  const tempDir = await mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const outputPath = path.join(tempDir, "reply.md");
  try {
    const args = buildCodexArgs(config, projectRoot, outputPath);
    const codexPath = await resolveCodexPath(llm.codexPath);
    await runProcess(codexPath, args, {
      cwd: projectRoot,
      input: prompt,
      timeoutMs: llm.timeoutMs || 120000
    });
    return (await readFile(outputPath, "utf8")).trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
