import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodexArgs, resolveCodexPath } from "../src/llm.js";

test("Codex Agent 显式固定 medium 推理力度", () => {
  const args = buildCodexArgs(
    { llm: { model: "gpt-5.6-terra", reasoningEffort: "medium" } },
    "/project",
    "/tmp/reply.md"
  );
  assert.deepEqual(
    args.slice(args.indexOf("-c"), args.indexOf("-c") + 2),
    ["-c", "model_reasoning_effort=\"medium\""]
  );
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!args.includes("read-only"));
  assert.ok(!args.includes("shell_tool"));
  assert.ok(!args.includes("--output-schema"));
  assert.ok(args.includes("/tmp/reply.md"));
});

test("配置的 Codex 路径失效时自动发现最新可执行版本", async () => {
  const extensionRoot = await mkdtemp(path.join(os.tmpdir(), "codex-extension-test-"));
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch;
  const oldCodex = path.join(
    extensionRoot,
    "openai.chatgpt-26.1.0-darwin-arm64",
    "bin",
    `macos-${architecture}`,
    "codex"
  );
  const latestCodex = path.join(
    extensionRoot,
    "openai.chatgpt-26.10.0-darwin-arm64",
    "bin",
    `macos-${architecture}`,
    "codex"
  );
  try {
    for (const candidate of [oldCodex, latestCodex]) {
      await mkdir(path.dirname(candidate), { recursive: true });
      await writeFile(candidate, "#!/bin/sh\nexit 0\n");
      await chmod(candidate, 0o755);
    }
    assert.equal(
      await resolveCodexPath("/missing/codex", { extensionRoot }),
      latestCodex
    );
  } finally {
    await rm(extensionRoot, { recursive: true, force: true });
  }
});
