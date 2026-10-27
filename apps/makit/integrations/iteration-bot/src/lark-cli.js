import { spawn } from "node:child_process";
import { createMakitRecords } from './makit-records.js';

export class CliError extends Error {
  constructor(message, { args = [], stdout = "", stderr = "", code = null } = {}) {
    super(message);
    this.name = "CliError";
    this.args = args;
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

export function createLarkCli(config) {
  const makitRecords = createMakitRecords(config);
  const binary = config.runtime?.larkCliPath || "lark-cli";
  let consecutiveTransientFailures = 0;
  let circuitOpenUntil = 0;

  function transientFailure(error) {
    const detail = [
      error?.message,
      error?.stdout,
      error?.stderr
    ].filter(Boolean).join(" ").toLowerCase();
    return [
      "超时",
      "timeout",
      "network",
      "no such host",
      "tls handshake",
      "connection reset",
      "connection refused"
    ].some((token) => detail.includes(token));
  }

  function recordFailure(error) {
    if (!transientFailure(error)) return;
    consecutiveTransientFailures += 1;
    const threshold = Number(config.runtime?.larkCliCircuitFailureThreshold || 2);
    if (consecutiveTransientFailures < threshold) return;
    const breakSeconds = Number(config.runtime?.larkCliCircuitBreakSeconds || 45);
    circuitOpenUntil = Date.now() + breakSeconds * 1000;
  }

  async function json(args, options = {}) {
    if (makitRecords && args[0] === 'base') return makitRecords(args);
    try {
      if (Date.now() < circuitOpenUntil) {
        throw new CliError(
          `lark-cli 网络熔断中，将在 ${new Date(circuitOpenUntil).toISOString()} 后重试`,
          { args }
        );
      }
      const result = await exec([...args, "--format", "json"], options);
      const trimmed = result.stdout.trim();
      if (!trimmed) {
        consecutiveTransientFailures = 0;
        circuitOpenUntil = 0;
        return null;
      }
      const parsed = JSON.parse(trimmed);
      if (parsed?.ok === false) {
        throw new CliError(parsed.error?.message || parsed.message || "lark-cli 请求失败", {
          args,
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code
        });
      }
      consecutiveTransientFailures = 0;
      circuitOpenUntil = 0;
      return parsed;
    } catch (error) {
      const normalized = error instanceof CliError
        ? error
        : new CliError(`无法解析 lark-cli JSON 输出: ${error.message}`, { args });
      recordFailure(normalized);
      throw normalized;
    }
  }

  function exec(
    args,
    { timeoutMs = Number(config.runtime?.larkCliTimeoutMs || 20_000) } = {}
  ) {
    if (makitRecords && args[0] === 'base') return Promise.reject(new CliError('Bitable CLI is retired; use the Makit data adapter'));
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new CliError(`lark-cli 超时（${timeoutMs}ms）`, { args, stdout, stderr }));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new CliError(`无法启动 lark-cli: ${error.message}`, { args, stdout, stderr }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new CliError(stderr.trim() || stdout.trim() || `lark-cli 退出码 ${code}`, {
            args,
            stdout,
            stderr,
            code
          }));
          return;
        }
        resolve({ code, stdout, stderr });
      });
    });
  }

  function spawnEventConsumer() {
    return spawn(binary, [
      "event",
      "consume",
      "im.message.receive_v1",
      "--as",
      config.identities.events,
      "--quiet"
    ], {
      env: process.env,
      // event consume treats stdin EOF as a shutdown signal. Keep a pipe open
      // so launchd/non-interactive execution remains connected.
      stdio: ["pipe", "pipe", "pipe"]
    });
  }

  return { binary, exec, json, spawnEventConsumer };
}
