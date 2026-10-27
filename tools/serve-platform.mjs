import { resolve } from "node:path";
if (!process.env.COBUILD_CONFIG && !process.env.COBUILD_DATA_DIR) {
  process.env.COBUILD_CONFIG = ".local/development/config.json";
  process.env.COBUILD_DATA_DIR = ".local/development/data";
}
if (!process.env.COBUILD_CONFIG || !process.env.COBUILD_DATA_DIR)
  throw new Error(
    "Set both COBUILD_CONFIG and COBUILD_DATA_DIR to isolated local paths",
  );
process.env.COBUILD_CONFIG = resolve(process.env.COBUILD_CONFIG);
process.env.COBUILD_DATA_DIR = resolve(process.env.COBUILD_DATA_DIR);
const { suiteConfig, assertNativeRuntime } =
  await import("../packages/config/runtime.mjs");
assertNativeRuntime();
const origin = new URL(suiteConfig.origins.platform);
if (
  origin.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(origin.hostname) ||
  !origin.port
)
  throw new Error("Local runner requires an explicit loopback HTTP port");
if (
  Object.values(suiteConfig.integrations).some(Boolean) ||
  suiteConfig.delivery.externalMessages
)
  throw new Error(
    "External integrations and delivery are disabled in the isolated local runner",
  );
const { createHttpServer } = await import("../apps/platform/server/http.mjs");
const server = await createHttpServer();
server.listen(Number(origin.port), "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      ready: true,
      origin: origin.origin,
      modules: suiteConfig.modules,
    }),
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    server.close(async () => {
      await server.workflowClosed;
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
