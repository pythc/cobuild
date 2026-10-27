import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { localApplicationEnvironment } from "../packages/config/local-environment.mjs";
const config = JSON.parse(
    readFileSync(
      new URL("../config/cobuild.local.example.json", import.meta.url),
    ),
  ),
  org = "12345678-1234-4321-9123-123456789abc";
test("core adapters derive native identity, callbacks, session age and disabled delivery from one configuration", () => {
  const a = localApplicationEnvironment(config, "makit", org),
    b = localApplicationEnvironment(config, "weknow", org);
  assert.equal(a.COBUILD_IDENTITY_ORIGIN, config.origins.platform);
  assert.equal(b.LAB_IDENTITY_ORIGIN, config.origins.platform);
  assert.equal(a.LAB_IDENTITY_TENANT_KEY, b.LAB_IDENTITY_TENANT_KEY);
  assert.equal(b.JWT_TOKEN_EXPIRES_IN, "30d");
  assert.equal(a.MAKIT_WORKERS_ENABLED, "false");
  assert.equal(a.MAKIT_EXTERNAL_WRITES_ENABLED, "false");
  assert.equal(b.FEISHU_ENABLED, "false");
  assert.equal(a.SERVER_HOST, "127.0.0.1");
  assert.equal(b.HOST, "127.0.0.1");
  assert.ok(
    !Object.keys({ ...a, ...b }).some((k) =>
      /PASSWORD|SECRET|TOKEN$|DATABASE_URL/.test(k),
    ),
  );
});
test("disabled services cannot receive an environment, and public destinations cannot enter the local runner", () => {
  assert.equal(
    localApplicationEnvironment(
      { ...config, modules: ["platform"] },
      "makit",
      org,
    ),
    null,
  );
  assert.throws(() =>
    localApplicationEnvironment(
      {
        ...config,
        origins: { ...config.origins, makit: "https://team.example" },
      },
      "makit",
      org,
    ),
  );
  assert.throws(() =>
    localApplicationEnvironment(config, "makit", "display-slug"),
  );
  assert.throws(() =>
    localApplicationEnvironment(
      { ...config, integrations: { ...config.integrations, feishu: true } },
      "makit",
      org,
    ),
  );
});
