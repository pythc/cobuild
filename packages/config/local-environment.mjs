import { validateConfig } from "./index.mjs";

/** Non-secret adapters for host Node processes. Database/session secrets stay private. */
export function localApplicationEnvironment(input, id, organizationId) {
  const config = validateConfig(input);
  if (!["makit", "weknow"].includes(id))
    throw new TypeError("Unsupported local application");
  if (!config.modules.includes(id)) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(organizationId || ""))
    throw new TypeError("An initialized organization ID is required");
  const url = new URL(config.origins[id]),
    issuer = new URL(config.origins.platform);
  for (const u of [url, issuer])
    if (
      u.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(u.hostname) ||
      !u.port
    )
      throw new TypeError("Local applications require explicit loopback ports");
  if (
    config.identity.providers.join(",") !== "local" ||
    config.identity.selfRegistration ||
    Object.values(config.integrations).some(Boolean) ||
    config.delivery.externalMessages
  )
    throw new TypeError(
      "Local native identity and disabled integrations required",
    );
  const common = {
    COBUILD_IDENTITY_MODE: "local",
    COBUILD_MODULE_ENABLED: "true",
    LAB_IDENTITY_TENANT_KEY: organizationId,
  };
  return id === "makit"
    ? {
        ...common,
        COBUILD_IDENTITY_ORIGIN: issuer.origin,
        COBUILD_WEKNOW_ORIGIN: config.modules.includes("weknow")
          ? config.origins.weknow
          : "",
        MAKIT_PUBLIC_URL: url.origin,
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: url.port,
        MAKIT_STORAGE: "postgres",
        MAKIT_WORKERS_ENABLED: "false",
        MAKIT_AI_REVIEW_ENABLED: String(config.integrations.ai),
        MAKIT_EXTERNAL_WRITES_ENABLED: "false",
        REQUIREMENT_PLATFORM_APP_ID: "cobuild-local",
      }
    : {
        ...common,
        APP_URL: url.origin,
        HOST: "127.0.0.1",
        PORT: url.port,
        LAB_IDENTITY_ENABLED: "true",
        LAB_IDENTITY_ORIGIN: issuer.origin,
        FEISHU_ENABLED: "false",
        FEISHU_DIRECTORY_ENABLED: "false",
        COBUILD_ORGANIZATION_NAME: config.organization.name,
        JWT_TOKEN_EXPIRES_IN: config.identity.sessionDays + "d",
        STORAGE_DRIVER: "local",
        DISABLE_TELEMETRY: "true",
      };
}
