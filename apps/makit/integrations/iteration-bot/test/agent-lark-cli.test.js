import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after } from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, "..");
const wrapper = path.join(projectRoot, "src", "agent-lark-cli.js");
const temporary = mkdtempSync(path.join(tmpdir(), 'makit-bot-cli-'));
const binary = path.join(temporary, 'fake-lark-cli');
writeFileSync(binary, '#!/usr/bin/env node\nconsole.log("mock help");\n', { mode: 0o700 });
const isolatedConfig = path.join(temporary, 'config.json');
writeFileSync(isolatedConfig, JSON.stringify({ runtime: { larkCliPath: binary }, notifications: { mode: 'test_only' } }));
after(() => rmSync(temporary, { recursive: true, force: true }));

function run(args, configPath = isolatedConfig) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FEISHU_ITERATION_BOT_CONFIG: configPath
    }
  });
}

test("Agent CLI 隔离期硬拦截消息发送", () => {
  const result = run(["im", "+messages-send", "--chat-id", "oc_external"]);
  assert.equal(result.status, 23);
  assert.match(result.stderr, /通知隔离期/);
});

test("Agent CLI 隔离期硬拦截原生 API 绕行", () => {
  const result = run(["raw", "POST", "/open-apis/im/v1/messages"]);
  assert.equal(result.status, 23);
  assert.match(result.stderr, /原生 API/);
});

test("Agent CLI 允许读取帮助", () => {
  const result = run(["im", "+messages-send", "--help"]);
  assert.equal(result.status, 0);
});
