import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID, randomBytes, createHash } from "node:crypto";
const root = new URL("../", import.meta.url).pathname;
async function freePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
test(
  "restart toggles gate pages/API/MCP, retain data and keep native login persistent",
  { timeout: 60000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "cobuild-runtime-")),
      data = join(directory, "data"),
      file = join(directory, "config.json");
    const config = JSON.parse(
      readFileSync(
        new URL("../config/cobuild.local.example.json", import.meta.url),
      ),
    );
    config.modules = ["platform", "kick"];
    config.origins.platform = "http://127.0.0.1:" + (await freePort());
    const base = config.origins.platform;
    let child,
      output = "",
      cookie = "",
      csrf;
    async function start(modules) {
      config.modules = modules;
      writeFileSync(file, JSON.stringify(config));
      output = "";
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        COBUILD_CONFIG: file,
        COBUILD_DATA_DIR: data,
        NODE_OPTIONS: "--require=" + root + "tools/local-network-guard.cjs",
      };
      child = spawn(process.execPath, ["tools/serve-platform.mjs"], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null)
          throw Error("Local process exited before readiness");
        try {
          const r = await fetch(base + "/healthz");
          if (r.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error("Readiness timeout");
    }
    async function stop() {
      const p = child;
      child = null;
      if (p && p.exitCode === null) {
        p.kill("SIGTERM");
        await once(p, "exit");
        assert.equal(p.exitCode, 0, "graceful local shutdown");
      }
    }
    async function api(path, body, headers = {}) {
      const r = await fetch(base + path, {
        redirect: "manual",
        headers: {
          Cookie: cookie,
          ...(body
            ? {
                Origin: base,
                "Content-Type": "application/json",
                "X-CSRF-Token": csrf,
              }
            : {}),
          ...headers,
        },
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let value;
      try {
        value = JSON.parse(text);
      } catch {}
      return { status: r.status, value, text, headers: r.headers };
    }
    try {
      await start(["platform", "kick"]);
      const setupKey = readFileSync(
        join(data, "bootstrap.private.key"),
        "utf8",
      ).trim();
      let r = await api(
        "/api/auth/bootstrap",
        {
          email: "owner@example.test",
          name: "Local Owner",
          password: "Runtime fixture password 123",
        },
        { "X-Bootstrap-Token": setupKey },
      );
      assert.equal(r.status, 200);
      cookie = r.headers.get("set-cookie").split(";")[0];
      csrf = r.value.csrf;
      assert.equal((await api("/api/workspace/todos")).status, 200);
      const fields = {
        name: "Persistent project",
        summary: "Local only",
        members: [],
        links: { repository: "", requirements: "", docs: "", demo: "" },
      };
      r = await api("/api/workspace/projects", fields);
      assert.equal(r.status, 201);
      const projectId = r.value.id;
      for (const path of [
        "/honors",
        "/api/honors/session",
        "/recruitment",
        "/api/recruitment-admin/session",
        "/api/admin/session",
      ])
        assert.equal((await api(path)).status, 404, path);
      const rpc = (body) =>
        api("/mcp", body, { Accept: "application/json, text/event-stream" });
      r = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      assert.equal(r.status, 200);
      assert.ok(
        !r.value.result.tools.some((t) => t.name === "lab_honors_list"),
      );
      r = await api("/api/auth/tokens", { scopes: ["projects:read"] });
      assert.equal(r.status, 201);
      const token = r.value.token;
      r = await rpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lab_projects_list", arguments: {} },
      });
      assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'),/realm="CoBuild"/);
    assert.ok(!r.headers.get('www-authenticate').includes('110-lab'));
      r = await api(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "lab_projects_list", arguments: {} },
        },
        {
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer " + token,
        },
      );
      assert.equal(r.status, 200);
      assert.ok(
        r.value.result.structuredContent.items.some((p) => p.id === projectId),
      );
      await stop();
      await start(["platform", "kick", "honors", "hiflow", "publishing"]);
      assert.equal(
        (await api("/api/auth/session")).status,
        200,
        "login survives restart",
      );
      assert.equal(
        (await api("/api/workspace/projects/" + projectId)).status,
        200,
        "projects survive restart",
      );
      for (const path of [
        "/honors",
        "/recruitment",
        "/api/honors/session",
        "/api/recruitment-admin/session",
        "/api/admin/session",
      ])
        assert.equal((await api(path)).status, 200, path);
      r = await rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: {},
      });
      assert.ok(r.value.result.tools.some((t) => t.name === "lab_honors_list"));
      assert.ok(
        r.value.result.tools.some((t) => t.name === "lab_candidates_list"),
      );
      const files = readdirSync(data, { recursive: true }).filter(
        (n) => typeof n === "string" && /honor|recruitment/.test(n),
      );
      assert.ok(files.length > 0, "enabled modules open their own stores");
      await stop();
      await start(["platform"]);
      for (const path of [
        "/projects",
        "/api/workspace/projects",
        "/api/workspace/project-actions",
        "/honors",
        "/api/honors/records",
        "/recruitment",
        "/api/recruitment-admin/session",
        "/api/admin/session",
      ])
        assert.equal((await api(path)).status, 404, path);
      r = await api("/healthz");
      for (const k of [
        "recruitmentEnabled",
        "recruitmentTestEnabled",
        "recruitmentWorkflowEnabled",
        "honorsEnabled",
        "dynamicManagement",
        "externalMessages",
        "projectSyncEnabled",
        "knowledgeWorkerEnabled",
      ])
        assert.equal(r.value[k], false, k);
      assert.equal(
        (await api("/api/workspace/todos")).status,
        200,
        "platform todo aggregation tolerates disabled modules",
      );
      r = await api(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "lab_projects_list", arguments: {} },
        },
        {
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer " + token,
        },
      );
      assert.equal(
        r.value.error.code,
        -32601,
        "old token cannot bypass module off",
      );
      assert.equal(
        (await api("/api/auth/tokens", { scopes: ["projects:read"] })).status,
        400,
        "cannot grant disabled scope",
      );
      await stop();
      await start(["platform", "kick", "honors"]);
      assert.equal(
        (await api("/api/workspace/projects/" + projectId)).status,
        200,
        "off/on never deletes business data",
      );
      assert.equal((await api("/api/honors/session")).status, 200);
    } finally {
      await stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
