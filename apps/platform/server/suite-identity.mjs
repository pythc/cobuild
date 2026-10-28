import { WorkspaceError } from "./workspace-store.mjs";
import {
  serviceKey,
  verifyService,
} from "../../../packages/service/channel.mjs";
import { runProjectBridge } from "./project-action-bridge.mjs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { openSuiteAuth } from "./suite-auth-store.mjs";
import { openUnifiedIdentity } from "./unified-identity.mjs";
import { MailAuthError } from "./mail-auth.mjs";
import { suiteAccountPage } from "./suite-account-page.mjs";
import { suiteAuthPage } from "./suite-auth-page.mjs";
import { suiteOrganizationPage } from "./suite-organization-page.mjs";
import {
  applicationModules,
  suiteApplications,
  businessModule,
} from "../../../packages/config/runtime.mjs";
import { BUSINESS_TOOLS } from "./business-tools.mjs";

const json = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(value));
};
const safeNext = (value) =>
  typeof value === "string" &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !/[\\\x00-\x20]/.test(value) &&
  value.length < 3000
    ? value
    : "/workbench";
async function read(req) {
  if (
    String(req.headers["content-type"] || "").split(";")[0] !==
    "application/json"
  )
    throw new MailAuthError(415, "请使用 JSON 请求");
  let size = 0,
    parts = [];
  const timer = setTimeout(() => req.destroy(), 8000);
  timer.unref();
  try {
    for await (const chunk of req) {
      if ((size += chunk.length) > 32768)
        throw new MailAuthError(413, "请求过长");
      parts.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(parts));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new MailAuthError(400, "请求格式无效");
    return value;
  } catch (error) {
    if (error instanceof MailAuthError) throw error;
    throw new MailAuthError(400, "请求格式无效");
  } finally {
    clearTimeout(timer);
  }
}
function createRegistry(config) {
  const definitions = [
    ["requirements", "makit", "Makit", "/callback/110lab_requirements"],
    ["knowledge", "weknow", "WeKnow", "/api/auth/identity/callback"],
    ["relay", "relay", "Relay", "/relay/auth/callback"],
  ];
  const entries = new Map(
    definitions
      .filter(([, module]) => config.modules.includes(module))
      .map(([id, module, name, path]) => {
        const url = config.origins[module],
          entry = {
            id,
            name,
            url,
            icon: "apps",
            redirectUris: [url + path],
            scopes: ["identity:profile", "identity:email", "identity:role"],
            automatic: false,
            legacy: false,
          };
        entry.policyHash = createHash("sha256")
          .update(JSON.stringify(entry))
          .digest("hex");
        return [id, Object.freeze(entry)];
      }),
  );
  return {
    get: (id) => entries.get(id),
    allows: (id, url) => entries.get(id)?.redirectUris.includes(url) === true,
    services: Object.fromEntries(
      [...entries].map(([id, a]) => [
        id,
        {
          name: a.name,
          url: a.url,
          icon: a.icon,
          federated: true,
          scopes: a.scopes.map((id) => ({ id, label: id })),
        },
      ]),
    ),
    project: (profile) => ({
      ...profile,
      provider: "local",
      userId: profile.unionId,
      organizationId: profile.tenantKey,
    }),
  };
}
export function createSuiteIdentity({ config, directory, now = Date.now }) {
  if (
    config.identity.providers.join(",") !== "local" ||
    config.identity.selfRegistration
  )
    throw new Error(
      "This suite runtime currently supports invited local accounts only",
    );
  const auth = openSuiteAuth({ directory, config, now }),
    apps = suiteApplications(config),
    registry = createRegistry(config);
  let access, navigation, workspace;
  const keys = Object.fromEntries(
    ["makit", "weknow"]
      .filter((id) => config.modules.includes(id))
      .map((id) => {
        const p = join(directory, id + ".service.key");
        serviceKey(p, true);
        return [id, p];
      }),
  );
  const allowed = (id) =>
    Boolean(
      applicationModules[id] && config.modules.includes(applicationModules[id]),
    );
  const checkApp = async (actor, id) => {
    auth.profile(actor.subject);
    if (!allowed(id)) throw new MailAuthError(403, "应用未启用");
    await access?.authorize(actor, id);
  };
  let identity;
  try {
    identity = openUnifiedIdentity({
      directory,
      auth,
      access: { me: auth.profile },
      directoryProvider: { list: async () => auth.members() },
      registry,
      issuer: config.origins.platform,
      now,
      authorizeApplication: checkApp,
    });
  } catch (error) {
    auth.close();
    throw error;
  }
  const actor = (req) => {
    const session = auth.session(req.headers.cookie);
    return {
      ...auth.profile(session.subject),
      csrf: session.csrf,
      expiresAt: session.expiresAt,
    };
  };
  const allowedScopes = new Set(
    BUSINESS_TOOLS.filter((tool) =>
      config.modules.includes(businessModule(tool)),
    )
      .map((tool) => tool.scope)
      .filter(Boolean),
  );
  const writes = (req) => {
    if (
      req.headers.origin !== config.origins.platform ||
      (req.headers["sec-fetch-site"] &&
        req.headers["sec-fetch-site"] !== "same-origin")
    )
      throw new MailAuthError(403, "请求来源无效");
  };
  const consentInput = (url) => ({
    audience: url.searchParams.get("audience"),
    redirectUri: url.searchParams.get("redirect_uri"),
    state: url.searchParams.get("state"),
    challenge: url.searchParams.get("code_challenge"),
  });
  return {
    enabled: true,
    suite: true,
    config,
    auth,
    registry,
    workspaceDirectory: join(directory, "workspace"),
    profile: auth.profile,
    setApplicationAccess(value) {
      access = value;
    },
    setWorkspace(value) {
      workspace = value;
    },
    setNavigation(value) {
      navigation = value;
    },
    roleForSubject: (subject) => auth.profile(subject).role,
    authorizeApplication: checkApp,
    assertApplication: (a, id) => {
      if (!allowed(id)) throw new MailAuthError(404, "应用未启用");
      access?.assertCached(a, id);
    },
    directorySnapshot: async () => ({
      members: auth.members(),
      departments: [],
      syncedAt: now(),
    }),
    projectMembers: async (subject) => {
      auth.profile(subject);
      return {
        members: auth.members(),
        source: "organization",
        unavailable: false,
      };
    },
    projectBridgeActor: async (subject) => auth.profile(subject),
    members: (subject) => {
      auth.profile(subject);
      return auth.members();
    },
    recentIdentity(req) {
      auth.recent(auth.session(req.headers.cookie));
    },
    identity(req, { write = false } = {}) {
      const session = auth.session(req.headers.cookie);
      if (write) auth.csrf(session, req.headers["x-csrf-token"]);
      return actor(req);
    },
    async businessIdentity(header, scopes) {
      const token = /^Bearer ([\w-]{43})$/.exec(header || "")?.[1],
        p = auth.inspectToken(token),
        current = p.scopes.filter((scope) => allowedScopes.has(scope));
      if (scopes.some((scope) => !current.includes(scope)))
        throw new MailAuthError(403, "个人访问令牌权限不足");
      return { ...p, scopes: current };
    },
    hostAuthorized: async () => false,
    mailboxReady: () => false,
    close() {
      identity.close();
      auth.close();
    },
    async handle(req, res, path) {
      if (
        ![
          "/organization",
          "/account",
          "/reset-password",
          "/login",
          "/join",
          "/setup",
          "/auth",
          "/auth/",
        ].includes(path) &&
        !path.startsWith("/api/suite/services/") &&
        !path.startsWith("/api/auth/") &&
        !path.startsWith("/api/identity/") &&
        ![
          "/api/mail/session",
          "/api/mail/logout",
          "/api/mail/auth/start",
          "/api/mail/members",
          "/api/organization/users",
          "/api/organization/invitations",
        ].includes(path) &&
        !path.startsWith("/api/organization/users/") &&
        path !== "/api/suite/config"
      )
        return false;
      try {
        const url = new URL(req.url, config.origins.platform);
        if (path.startsWith("/api/suite/services/")) {
          const match =
            /^\/api\/suite\/services\/(makit|weknow)\/(directory|member|actions|project|project-access)$/.exec(
              path,
            );
          if (!match || req.method !== "POST" || !keys[match[1]])
            throw new MailAuthError(404, "连接未启用");
          let payload;
          try {
            payload = verifyService(
              req.headers,
              await read(req),
              path,
              keys[match[1]],
            );
          } catch {
            throw new MailAuthError(401, "服务身份无效");
          }
          if (payload.organizationId !== auth.organizationId)
            throw new MailAuthError(403, "组织不匹配");
          const app = match[1],
            action = match[2];
          if (action === "member" && app === "makit") {
            const p = auth.profile(payload.userId);
            await checkApp(p, "requirements");
            json(res, 200, p);
            return true;
          }
          if (action === "directory") {
            json(res, 200, auth.directorySnapshot());
            return true;
          }
          if (action === "project-access" && app === "weknow") {
            const member = auth.profile(payload.subject);
            await checkApp(member, "knowledge");
            const projects = config.modules.includes("kick") && workspace
              ? workspace.store.list(member).projects.filter(p => p.phase === "active" && !p.archived &&
                  (p.ownerSubject === member.subject || p.members.some(m => m.subject === member.subject)))
                .map(p => ({ id: p.id, revision: p.revision, role: p.ownerSubject === member.subject ? "admin" : "writer" })) : [];
            json(res, 200, { organizationId: auth.organizationId, subject: member.subject, projects });
            return true;
          }
          if (!config.modules.includes("kick") || !workspace)
            throw new MailAuthError(404, "项目未启用");
          if (action === "actions" && app === "makit") {
            const v = payload.command;
            if (
              !v ||
              Object.keys(v).some(
                (k) =>
                  ![
                    "requestId",
                    "subject",
                    "at",
                    "action",
                    "projectId",
                    "input",
                  ].includes(k),
              ) ||
              typeof v.subject !== "string" ||
              !/^[-a-f0-9]{36}$/.test(v.projectId || "") ||
              ![
                "read",
                "knowledge_link",
                "milestone_add",
                "milestone_set",
              ].includes(v.action) ||
              !/^[-a-f0-9]{36}$/.test(v.requestId || "")
            )
              throw new MailAuthError(400, "项目操作无效");
            json(
              res,
              200,
              await runProjectBridge(v, { store: workspace.store, mail: this }),
            );
            return true;
          }
          if (action === "project" && app === "weknow") {
            const snapshot = auth.directorySnapshot(),
              p = workspace.store.get(
                auth.profile(
                  snapshot.members.find(
                    (m) => m.active && m.role === "super_admin",
                  )?.id,
                ),
                payload.projectId,
              );
            if (
              p.phase !== "active" ||
              p.archived ||
              !p.knowledgeSpace?.requested
            )
              throw new MailAuthError(409, "项目未批准创建知识空间");
            const owner = auth.profile(p.ownerSubject);
            await checkApp(owner, "knowledge");
            json(res, 200, { project: p, owner });
            return true;
          }
          throw new MailAuthError(404, "连接操作不存在");
        }
        if (
          ["/organization", "/account"].includes(path) &&
          req.method === "GET"
        ) {
          let a;
          try {
            a = actor(req);
          } catch {
            res.writeHead(302, {
              Location: "/login?next=" + encodeURIComponent(path),
            });
            res.end();
            return true;
          }
          if (path === "/organization") auth.administrator(a);
          const page =
            path === "/account"
              ? suiteAccountPage(config, a)
              : suiteOrganizationPage(config, a);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": page.csp,
            "Referrer-Policy": "no-referrer",
          });
          res.end(page.html);
          return true;
        }
        if (
          ["GET", "HEAD"].includes(req.method) &&
          [
            "/login",
            "/join",
            "/setup",
            "/auth",
            "/auth/",
            "/reset-password",
          ].includes(path)
        ) {
          let mode =
              path === "/reset-password"
                ? "reset"
                : path === "/join"
                  ? "join"
                  : auth.initialized()
                    ? "login"
                    : "setup",
            consent,
            next = safeNext(url.searchParams.get("next"));
          if (path.startsWith("/auth") && url.search) {
            consent = consentInput(url);
            identity.validate(consent);
            try {
              actor(req);
              mode = "consent";
              const app = registry.get(consent.audience);
              consent = { ...consent, name: app.name };
            } catch {
              next = "/auth" + url.search;
            }
          }
          const page = suiteAuthPage(config, mode, { next, consent });
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": page.csp,
            "Referrer-Policy": "no-referrer",
          });
          res.end(req.method === "HEAD" ? undefined : page.html);
          return true;
        }
        if (req.method === "GET") {
          if (path === "/api/auth/transfer-owner") {
            json(res, 200, { transfer: auth.transferStatus(actor(req)) });
            return true;
          }
          if (path === "/api/suite/config") {
            json(res, 200, {
              organization: config.organization,
              organizationId: auth.organizationId,
              apps: apps.apps,
              modules: config.modules,
              identity: { provider: "local", initialized: auth.initialized() },
              externalMessages: config.delivery.externalMessages,
            });
            return true;
          }
          if (path === "/api/identity/config") {
            json(res, 200, { enabled: true, services: registry.services });
            return true;
          }
          if (
            [
              "/api/mail/session",
              "/api/auth/session",
              "/api/identity/session",
            ].includes(path)
          ) {
            json(res, 200, actor(req));
            return true;
          }
          if (path === "/api/mail/members") {
            actor(req);
            json(res, 200, { members: auth.members() });
            return true;
          }
          if (path === "/api/organization/users") {
            json(res, 200, { users: auth.managedMembers(actor(req)) });
            return true;
          }
          throw new MailAuthError(404, "页面不存在");
        }
        if (req.method !== "POST") throw new MailAuthError(405, "请求方式无效");
        if (
          [
            "/api/identity/exchange",
            "/api/identity/inspect",
            "/api/identity/revoke",
          ].includes(path)
        ) {
          if (req.headers.origin || req.headers["sec-fetch-site"])
            throw new MailAuthError(403, "仅供服务连接使用");
          const input = await read(req),
            action = path.split("/").at(-1);
          const keys =
            action === "exchange"
              ? ["audience", "code", "state", "verifier", "redirectUri"]
              : ["audience", "token"];
          if (Object.keys(input).some((k) => !keys.includes(k)))
            throw new MailAuthError(400, "参数无效");
          json(res, 200, (await identity[action](input)) || { revoked: true });
          return true;
        }
        writes(req);
        const input = await read(req);
        if (path === "/api/auth/reset-password") {
          json(
            res,
            200,
            await auth.resetPassword(input, req.socket.remoteAddress),
          );
          return true;
        }
        if (
          path === "/api/auth/bootstrap" ||
          path === "/api/auth/login" ||
          path === "/api/auth/accept"
        ) {
          const result = path.endsWith("/bootstrap")
            ? await auth.bootstrap(input, req.headers["x-bootstrap-token"])
            : path.endsWith("/accept")
              ? await auth.accept(input)
              : await auth.login(input, req.socket.remoteAddress);
          res.setHeader("Set-Cookie", result.cookie);
          json(res, 200, {
            ...auth.profile(result.session.subject),
            csrf: result.session.csrf,
          });
          return true;
        }
        if (path === "/api/mail/auth/start") {
          json(res, 200, {
            state: randomBytes(32).toString("base64url"),
            launchUrl:
              config.origins.platform +
              "/login?next=" +
              encodeURIComponent(safeNext(input.returnTo)),
          });
          return true;
        }
        const session = auth.session(req.headers.cookie);
        auth.csrf(session, req.headers["x-csrf-token"]);
        if (
          [
            "/api/auth/change-password",
            "/api/auth/recovery",
            "/api/auth/transfer-owner",
          ].includes(path)
        ) {
          const method = path.endsWith("change-password")
            ? "changePassword"
            : path.endsWith("recovery")
              ? "issueRecovery"
              : "transferOwner";
          json(res, 200, await auth[method](session, input));
          return true;
        }
        if (path === "/api/auth/tokens") {
          if (
            Object.keys(input).some((k) => k !== "scopes") ||
            !Array.isArray(input.scopes) ||
            !input.scopes.length ||
            input.scopes.length > 100 ||
            new Set(input.scopes).size !== input.scopes.length ||
            input.scopes.some((s) => !allowedScopes.has(s))
          )
            throw new MailAuthError(400, "令牌权限无效或对应模块未启用");
          json(res, 201, auth.issueToken(session, input.scopes));
          return true;
        }
        if (
          [
            "/api/auth/logout",
            "/api/mail/logout",
            "/api/identity/logout",
          ].includes(path)
        ) {
          res.setHeader("Set-Cookie", auth.logout(session));
          json(res, 200, { loggedOut: true });
          return true;
        }
        if (path === "/api/organization/invitations") {
          json(res, 201, auth.invite(actor(req), input));
          return true;
        }
        if (path.startsWith("/api/organization/users/")) {
          json(
            res,
            200,
            auth.updateMember(actor(req), path.split("/").at(-1), input),
          );
          return true;
        }
        const action = ["validate", "continuation", "authorize"].find(
          (v) => path === "/api/identity/" + v,
        );
        if (action) {
          if (
            Object.keys(input).some(
              (k) =>
                !["audience", "redirectUri", "state", "challenge"].includes(k),
            )
          )
            throw new MailAuthError(400, "参数无效");
          json(
            res,
            200,
            action === "validate"
              ? identity.validate(input)
              : await identity[action](
                  req.headers.cookie,
                  req.headers["x-csrf-token"],
                  input,
                ),
          );
          return true;
        }
        throw new MailAuthError(404, "页面不存在");
      } catch (error) {
        req.resume();
        if (!res.headersSent)
          json(
            res,
            error instanceof MailAuthError || error instanceof WorkspaceError
              ? error.status
              : 503,
            {
              error:
                error instanceof MailAuthError ||
                error instanceof WorkspaceError
                  ? error.message
                  : "暂时无法完成身份操作",
            },
          );
        return true;
      }
    },
  };
}
