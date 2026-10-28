import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateConfig, registry, capabilities } from "./index.mjs";

const filename = process.env.COBUILD_CONFIG;
export const suiteConfig = filename
  ? validateConfig(JSON.parse(readFileSync(resolve(filename), "utf8")))
  : null;
export const suiteEnabled = Boolean(suiteConfig);
export const nativeRuntimeModules = capabilities.ids;
export function assertNativeRuntime(config = suiteConfig) {
  if (!config) return;
  const pending = config.modules.filter(
    (id) => !nativeRuntimeModules.includes(id),
  );
  if (pending.length)
    throw new Error(
      "Modules not yet connected to the native suite runtime: " +
        pending.join(", "),
    );
  if (
    config.identity.providers.join(",") !== "local" ||
    config.identity.selfRegistration
  )
    throw new Error(
      "Native runtime currently supports invited local accounts only",
    );
  if (
    Object.values(config.integrations).some(Boolean) ||
    config.delivery.externalMessages
  )
    throw new Error(
      "Native suite integrations and external delivery are not yet enabled",
    );
}
export const applicationModules = Object.freeze({
  ...Object.fromEntries(registry.modules.flatMap(m => m.applications.map(id => [id,m.id]))),
  "recruitment-test": "hiflow",
  recruitment: "hiflow",
  assessment: "evalab",
  relay: "relay",
  honors: "honors",
  "public-mail": "mail",
  mail: "mail",
  "updates-admin": "publishing",
  updates: "publishing",
  monitoring: "pulse",
});
export const moduleEnabled = (id) =>
  !suiteConfig || suiteConfig.modules.includes(id);
export const applicationEnabled = (id) =>
  !suiteConfig ||
  Boolean(applicationModules[id] && moduleEnabled(applicationModules[id]));
export const portalOrigin = () =>
  suiteConfig?.origins.platform || "https://internal.110-lab.cn";
export const portalHost = () => new URL(portalOrigin()).hostname;
export const portalRequestHost = (host) => host === portalHost();
export function portalRequestOrigin(req, localTest = false) {
  if (suiteConfig) return req.headers.origin === suiteConfig.origins.platform;
  return (
    req.headers.origin === portalOrigin() ||
    (localTest &&
      ["127.0.0.1", "localhost", "[::1]"].includes(
        new URL("http://" + req.headers.host).hostname,
      ) &&
      req.headers.origin === "http://" + req.headers.host)
  );
}
export function requireApplication(id) {
  if (!applicationEnabled(id))
    throw Object.assign(new Error("应用未启用"), {
      status: 404,
      code: "MODULE_DISABLED",
    });
}
export function moduleForPath(path) {
  if (
    /^\/(?:api\/workspace\/(?:embedded\/)?recruitment|recruitment|api\/recruitment|media\/recruitment)(?:[/-]|$)/.test(
      path,
    )
  )
    return "hiflow";
  if (
    /^\/(?:projects|api\/workspace\/(?:embedded\/)?(?:projects|members|project-actions))(?:[/-]|$)/.test(
      path,
    )
  )
    return "kick";
  if (/^\/(?:honors|api\/honors|media\/honors)(?:[/-]|$)/.test(path))
    return "honors";
  if (
    /^\/(?:mail|api\/mail\/(?:embedded\/)?(?:mailboxes|mailbox|drafts|messages|attachments))(?:[/-]|$)/.test(
      path,
    )
  )
    return "mail";
  if (/^\/(?:admin|api\/admin|api\/updates)(?:[/-]|$)/.test(path))
    return "publishing";
  if (/^\/(?:monitoring|api\/monitoring)(?:[/-]|$)/.test(path)) return "pulse";
  if (/^\/(?:sso\/assessment|assessment|api\/assessment)(?:[/-]|$)/.test(path))
    return "evalab";
  if (/^\/relay(?:\/|$)/.test(path)) return "relay";
  const entry = /^\/apps\/(?:enter|embedded)\/([a-z-]+)/.exec(path);
  if (entry) return applicationModules[entry[1]] || "excluded";
  return "platform";
}
export function businessModule(tool) {
  const scope = tool.scope || "";
  return scope.startsWith("projects:")
    ? "kick"
    : scope.startsWith("honors:")
      ? "honors"
      : scope.startsWith("recruitment:")
        ? "hiflow"
        : scope.startsWith("mail:")
          ? "mail"
          : scope.startsWith("updates:")
            ? "publishing"
            : "platform";
}
export function suiteApplications(config = suiteConfig) {
  if (!config) throw new Error("Suite configuration is required");
  const origin = config.origins.platform;
  const definitions = [
    [
      "projects",
      "Kick",
      "项目与里程碑",
      origin + "/projects",
      "projects",
      "项目协作",
    ],
    [
      "requirements",
      "Makit",
      "需求与迭代",
      config.origins.makit,
      "requirements",
      "研发协作",
    ],
    [
      "knowledge",
      "WeKnow",
      "文档与知识空间",
      config.origins.weknow,
      "knowledge",
      "知识沉淀",
    ],
    [
      "organization",
      "组织与权限",
      "成员、角色与应用访问",
      origin + "/organization",
      "organization",
      "组织管理",
    ],
    [
      "recruitment-test",
      "HiFlow",
      "候选人与面试安排",
      origin + "/recruitment",
      "recruitment",
      "招新",
    ],
    [
      "assessment",
      "Evalab",
      "考核与评审",
      config.origins.evalab,
      "assessment",
      "考核",
    ],
    [
      "relay",
      "Relay",
      "咨询与反馈",
      config.origins.relay,
      "requirements",
      "咨询",
    ],
    [
      "honors",
      "荣誉",
      "荣誉登记与审核",
      origin + "/honors",
      "honors",
      "团队扩展",
    ],
    [
      "public-mail",
      "公共邮箱",
      "邮箱与授权",
      origin + "/mail",
      "mail",
      "配套集成",
    ],
    [
      "updates-admin",
      "动态发布",
      "发布内容管理",
      origin + "/admin",
      "updates",
      "团队扩展",
    ],
    [
      "monitoring",
      "Pulse",
      "管理员运行状态",
      origin + "/monitoring",
      "monitoring",
      "运维",
    ],
  ];
  return {
    systems: {
      workbench: origin + "/workbench",
      requirements: config.origins.makit,
      knowledge: config.origins.weknow,
    },
    projects: [],
    apps: definitions
      .filter(
        ([id, , , url]) =>
          url && config.modules.includes(applicationModules[id]),
      )
      .map(([id, title, description, url, icon, edition]) => ({
        id,
        title,
        description,
        url,
        icon,
        edition,
        status: "available",
      })),
  };
}
export const moduleCatalog = registry.modules;
