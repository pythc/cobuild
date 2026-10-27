import "reflect-metadata";
import { verifyWidgetGrant } from "./widget-grants.mjs";
import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  lstatSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, resolve, extname } from "node:path";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { AiReception } from "./ai-reception.mjs";
import { RelayStore } from "./store.mjs";
import { NativeMakit } from "./native.mjs";
import { NoticeWorker } from "./notices.mjs";
import { ReminderWorker } from "./reminders.mjs";
import { ConsultationWorker } from "./consultations.mjs";
import { createIdentityClient } from "./identity-client.mjs";
import { ChatwootClient } from "./modules/relay/chatwoot-client.ts";
import { RelayChatwootService } from "./modules/relay/relay-chatwoot.service.ts";
import { FeishuService } from "./modules/requirements/feishu.service.ts";
const file = process.env.RELAY_CONFIG || "/data/110lab-relay/app/config.json";
const st = lstatSync(file);
if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077 || st.size > 65536)
  throw Error("Unsafe Relay configuration");
const config = JSON.parse(readFileSync(file, "utf8")),
  base = new URL(config.publicBase),
  prefix = base.pathname.replace(/\/$/, ""),
  origin = base.origin;
if (
  base.protocol !== "https:" ||
  base.pathname !== "/relay" ||
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  !config.tenantKey ||
  !config.storageBase ||
  !config.accessKey ||
  !config.makit?.endpoint ||
  !config.chatId
)
  throw Error("Invalid Relay public address");
process.env.RELAY_CHATWOOT_STORAGE_BASE = config.storageBase;
process.env.RELAY_CHATWOOT_CONFIG_JSON = JSON.stringify(config.chatwoot);
process.env.RELAY_PUBLIC_ORIGIN = origin;
process.env.RELAY_PUBLIC_BASE_URL = config.publicBase;
process.env.RELAY_SOURCE_ID = config.sourceId;
process.env.FEISHU_APP_ID = config.feishu.appId;
process.env.FEISHU_APP_SECRET = config.feishu.appSecret;
const store = new RelayStore(config.directory),
  db = store.db,
  keyFile = join(config.directory, "session.key");
if (!existsSync(keyFile))
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
const ks = lstatSync(keyFile);
if (!ks.isFile() || ks.isSymbolicLink() || ks.mode & 0o077 || ks.size !== 32)
  throw Error("Unsafe session key");
const key = readFileSync(keyFile);
const nonce = () => randomBytes(32).toString("base64url"),
  hash = (v) => createHash("sha256").update(v).digest("hex");
function seal(v, aad) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  return Buffer.concat([
    iv,
    c.update(JSON.stringify(v)),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64url");
}
function open(v, aad) {
  const b = Buffer.from(v, "base64url"),
    c = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  c.setAAD(Buffer.from(aad));
  c.setAuthTag(b.subarray(-16));
  return JSON.parse(Buffer.concat([c.update(b.subarray(12, -16)), c.final()]));
}
const fail = (status, message) => Object.assign(Error(message), { status });
const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim().split("="))
      .filter((v) => v.length === 2),
  );
const cookie = (name, value, seconds) =>
  `${name}=${value}; Path=${prefix || "/"}; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
const identity = createIdentityClient({
    audience: "relay",
    redirectUri: config.publicBase + "/auth/callback",
  }),
  feishu = new FeishuService(),
  members = new Map();
async function member(p) {
  let m = members.get(p.unionId);
  if (!m || m.expires < Date.now()) {
    const value = await feishu.getUserByUnionId(p.unionId);
    m = { value, expires: Date.now() + 60000 };
    members.set(p.unionId, m);
    if (members.size > 1000) members.clear();
  }
  return m.value;
}
const sessionCache = new Map();
async function actor(req) {
  const bearer = /^RelayWidget ([A-Za-z0-9_-]{43})$/.exec(
    String(req.headers.authorization || ""),
  );
  const sid =
    bearer?.[1] ||
    cookies(req).relay_embed_session ||
    cookies(req).relay_session;
  if (!/^[\w-]{43}$/.test(sid || "")) throw fail(401, "请通过 CoBuild 登录");
  const id = hash(sid),
    row = db
      .prepare("SELECT * FROM sessions WHERE id_hash=? AND expires>?")
      .get(id, Date.now());
  if (!row) throw fail(401, "请重新登录");
  const saved = open(row.encrypted, id);
  if (saved.widget) {
    if (!bearer || !config.widgetIssuers?.[saved.widget.issuer])
      throw fail(401, "客服连接已失效");
    return {
      employeeId: saved.widget.subject,
      name: saved.widget.name,
      openId: "",
      miaodaUserId: "",
      platformAppId: "",
      relayCustomer: true,
      relayApp: saved.widget.app,
      relayPrincipal: hash(
        saved.widget.issuer === "makit"
          ? "makit-member:" + config.makit.appId + ":" + saved.widget.subject
          : "widget:" + saved.widget.issuer + ":" + saved.widget.subject,
      ),
    };
  }
  let p = sessionCache.get(id);
  if (!p || p.checkedAt < Date.now() - 15000) {
    try {
      p = { ...(await identity.inspect(saved.token)), checkedAt: Date.now() };
    } catch (e) {
      if (e.status === 401) {
        // A local cookie can outlive the identity grant it references. Retire
        // only this rejected session; a service outage must not log people out.
        sessionCache.delete(id);
        db.prepare("DELETE FROM sessions WHERE id_hash=?").run(id);
        throw fail(401, "登录已失效，请重新登录");
      }
      if (e.status === 403)
        throw fail(403, "当前账号无法使用 Relay，请联系管理员");
      throw fail(503, "统一身份服务暂时不可用，请稍后重试");
    }
    if (p.subject !== saved.subject || p.tenantKey !== config.tenantKey)
      throw fail(401, "统一身份不匹配");
    sessionCache.set(id, p);
    if (sessionCache.size > 1000) sessionCache.clear();
  }
  const m = await member(p);
  return {
    employeeId: m.employeeId,
    openId: m.openId,
    name: m.name,
    miaodaUserId: "",
    platformAppId: config.makit.appId,
    relayToken: saved.token,
    relaySubject: p.subject,
  };
}
const access = {
  async allowed(employeeId) {
    const r = await fetch(
      "https://internal.110-lab.cn/api/application-access/service/relay",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          "X-Relay-Access-Key": config.accessKey,
        },
        body: JSON.stringify({ employeeId }),
      },
    );
    if (!r.ok) throw fail(503, "客服范围暂时无法核对");
    const v = await r.json();
    if (typeof v.allowed !== "boolean") throw fail(503, "客服范围暂时无法核对");
    return v.allowed;
  },
};
const native = new NativeMakit(config, store),
  chat = new ChatwootClient();
const service = new RelayChatwootService(
  chat,
  store,
  native,
  store,
  { requirementByIdAs: (id, a) => native.byRequirement(id, a) },
  {
    updateRequirementAs: (id, v, a) =>
      native.update(
        id,
        {
          revision: v.expectedUpdatedAt,
          status: v.patch.status,
          handlerIds: v.patch.handlerLarkUserIds,
          note: v.patch.latestProgress,
        },
        a,
      ),
  },
  access,
  store,
);
const notices = new NoticeWorker(config, store);
const consultations = new ConsultationWorker(chat, store);
const reminders = new ReminderWorker(config, store, service.attentionTracker, notices, access);
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    if (Buffer.isBuffer(v)) return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, normalize(x)]),
    );
  }
  return typeof v === "string" && v.startsWith("/api/") ? prefix + v : v;
}
function json(res, status, v) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, private",
  });
  res.end(JSON.stringify(normalize(v)));
}
async function body(req, max = 12 * 1024 * 1024) {
  let n = 0,
    parts = [];
  for await (const p of req) {
    if ((n += p.length) > max) throw fail(413, "内容过大");
    parts.push(p);
  }
  if (!n) return {};
  try {
    return JSON.parse(Buffer.concat(parts));
  } catch {
    throw fail(400, "请求格式无效");
  }
}
const ai = new AiReception({store, chat, config:config.ai});
service.ai = ai;
async function api(path, req, res, u, a) {
  const method = req.method,
    k = String(req.headers["idempotency-key"] || ""),
    operator = u.searchParams.get("view") === "operator";
  if (path === "/api/relay/navigation" && method === "GET") {
    if (!a.relayToken || a.relayCustomer) throw fail(403, "请通过 CoBuild 登录");
    const value = await identity.navigation(a.relayToken);
    if (value.subject !== a.relaySubject) throw fail(503, "收藏身份核对失败");
    return json(res, 200, value);
  }
  if (path === "/api/relay/profile" && method === "GET")
    return json(res, 200, await service.profile(a));
  if (path === "/api/support/profile" && method === "GET")
    return json(res, 200, await service.profile(a));
  if (path === "/api/relay/unread" && method === "GET")
    return json(res, 200, await service.unread(a));
  if (path === "/api/relay/state" && method === "GET")
    return json(
      res,
      200,
      await service.state(a, operator ? "operator" : "customer"),
    );
  if (path === "/api/relay/conversations" && method === "POST") {
    const v = await body(req);
    if (Object.keys(v).some((x) => x !== "app")) throw fail(400, "参数无效");
    return json(res, 200, await service.begin(a, String(v.app || "makit"), k));
  }
  let m = path.match(
    /^\/api\/relay\/conversations\/([\w-]+)\/(messages|resolve|claim|read|ai-mode)$/,
  );
  if (m && method === "POST") {
    const v = await body(req);
    return json(
      res,
      200,
      m[2] === "ai-mode"
        ? await service.aiMode(m[1], a, v)
        : m[2] === "read"
        ? await service.read(m[1], a, v, operator)
        : m[2] === "claim"
          ? await service.claim(m[1], a)
          : m[2] === "resolve"
            ? await service.resolve(m[1], a, k, v)
            : await service.send(m[1], a, v, k, operator),
    );
  }
  if (path === "/api/support/members" && method === "GET")
    return json(res, 200, await service.members(a));
  if (path === "/api/support/tickets" && method === "POST")
    return json(res, 200, await service.create(a, await body(req)));
  if (path === "/api/support/tickets" && method === "GET")
    return json(res, 200, await service.tickets(a));
  m = path.match(/^\/api\/support\/tickets\/([\w-]+)(\/group)?$/);
  if (m) {
    if (m[2] && method === "POST")
      return json(res, 200, await service.group(m[1], a));
    if (!m[2] && method === "GET")
      return json(res, 200, await service.tickets(a, m[1]));
    if (!m[2] && method === "PATCH")
      return json(res, 200, await service.update(m[1], a, await body(req), k));
  }
  m = path.match(/^\/api\/support\/context\/([\w-]+)$/);
  if (m && method === "GET")
    return json(res, 200, await service.context(m[1], a));
  m = path.match(
    /^\/api\/support\/context-by-marker\/(relay_v1:[a-f0-9]{64})$/,
  );
  if (m && method === "GET") {
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="relay-context.json"',
    );
    return json(res, 200, await service.contextByMarker(m[1], a));
  }
  m = path.match(/^\/api\/relay\/(native-)?attachments\/([\w-]+)\/(\d+)$/);
  if (m && method === "GET") {
    const f = await service.attachment(
      m[2],
      m[3],
      a,
      operator || u.searchParams.get("client") === "relay",
      !!m[1],
    );
    res.writeHead(200, {
      "Content-Type": f.mime,
      "Cache-Control": "no-store, private",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition":
        (/^image\/(png|jpeg|gif|webp)(;|$)/i.test(f.mime)
          ? "inline"
          : "attachment") + `; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    });
    return res.end(f.bytes);
  }
  throw fail(404, "接口不存在");
}
const publicDirectory = resolve(import.meta.dirname, "client");
const types = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".css": "text/css",
  ".js": "text/javascript",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain",
};
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  try {
    const forwarded = req.headers["x-relay-intranet-key"];
    if (
      typeof forwarded !== "string" ||
      typeof config.proxyKey !== "string" ||
      config.proxyKey.length < 32 ||
      Buffer.byteLength(forwarded) !== Buffer.byteLength(config.proxyKey) ||
      !timingSafeEqual(Buffer.from(forwarded), Buffer.from(config.proxyKey))
    )
      throw fail(403, "请求入口无效");
    if (req.headers.host !== base.host) throw fail(421, "请求地址无效");
    const u = new URL(req.url, origin);
    if (prefix && u.pathname !== prefix && !u.pathname.startsWith(prefix + "/"))
      throw fail(404, "页面不存在");
    const path = u.pathname.slice(prefix.length) || "/";
    if (path === "/api/healthz" && req.method === "GET")
      return json(res, 200, {
        mode: "live-chatwoot",
        identity: "cobuild",
        tickets: "native-makit",
        runtime: "intranet",
      });
    if (path === "/auth/widget" && req.method === "POST") {
      if (
        req.headers.origin !== origin ||
        req.headers["content-type"] !== "application/json"
      )
        throw fail(403, "请求来源无效");
      const v = await body(req, 6144);
      if (Object.keys(v).sort().join(",") !== "grant,verifier")
        throw fail(400, "客服身份参数无效");
      const claim = verifyWidgetGrant(
        v.grant,
        v.verifier,
        config.widgetIssuers,
      );
      if (!chat.config().apps[claim.app]) throw fail(503, "应用客服尚未配置");
      db.exec(
        "CREATE TABLE IF NOT EXISTS widget_grants(jti TEXT PRIMARY KEY,expires INTEGER NOT NULL)",
      );
      db.prepare("DELETE FROM widget_grants WHERE expires<?").run(Date.now());
      if (
        !db
          .prepare("INSERT OR IGNORE INTO widget_grants VALUES(?,?)")
          .run(hash(claim.jti), claim.exp).changes
      )
        throw fail(401, "客服身份已使用，请重新连接");
      const token = nonce(),
        id = hash(token),
        expires = Date.now() + 300000;
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        id,
        seal(
          {
            widget: {
              issuer: claim.iss,
              subject: claim.sub,
              name: claim.name,
              app: claim.app,
            },
          },
          id,
        ),
        expires,
      );
      return json(res, 200, { token, expiresAt: expires });
    }
    if (path === "/auth/start" && req.method === "GET") {
      const embedChallenge = u.searchParams.get("embed_challenge") || "";
      if (embedChallenge && !/^[\w-]{43}$/.test(embedChallenge))
        throw fail(400, "登录参数无效");
      const browser = nonce(),
        login = identity.begin(),
        view =
          u.searchParams.get("view") === "customer" ? "customer" : "operator";
      db.prepare("INSERT INTO flows VALUES(?,?,?,?,0)").run(
        login.flow.state,
        hash(browser),
        seal({ ...login.flow, view, embedChallenge }, login.flow.state),
        login.flow.expiresAt,
      );
      res.writeHead(303, {
        Location: login.url,
        "Set-Cookie": cookie("relay_flow", browser, 600),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      return res.end();
    }
    if (path === "/auth/callback" && req.method === "GET") {
      const state = u.searchParams.get("state"),
        browser = cookies(req).relay_flow;
      if (
        !/^[\w-]{43}$/.test(state || "") ||
        !/^[\w-]{43}$/.test(browser || "")
      )
        throw fail(400, "登录回调无效");
      const row = db
        .prepare(
          "UPDATE flows SET consumed=1 WHERE state=? AND browser_hash=? AND consumed=0 AND expires>? RETURNING *",
        )
        .get(state, hash(browser), Date.now());
      if (!row) throw fail(400, "登录已失效，请重新连接");
      const flow = open(row.encrypted, state),
        p = await identity.exchange(u.href, flow);
      if (p.tenantKey !== config.tenantKey) throw fail(403, "组织身份不符");
      await member(p);
      const sid = nonce(),
        id = hash(sid),
        expires = Math.min(Date.parse(p.expiresAt), Date.now() + 8 * 3600000);
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        id,
        seal({ token: p.token, subject: p.subject }, id),
        expires,
      );
      if (flow.embedChallenge) {
        const code = nonce();
        db.prepare("INSERT INTO handoffs VALUES(?,?,?,?)").run(
          hash(code),
          flow.embedChallenge,
          seal({ token: p.token, subject: p.subject }, hash(code)),
          Date.now() + 60000,
        );
        const scriptNonce = nonce();
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${scriptNonce}'; frame-ancestors 'none'; base-uri 'none'`,
        });
        return res.end(
          '<!doctype html><meta charset="utf-8"><title>Relay 登录完成</title><p>登录已完成，可以关闭本窗口。</p><script nonce="' +
            scriptNonce +
            '">if(window.opener){window.opener.postMessage(' +
            JSON.stringify({ type: "RELAY_AUTH_COMPLETE", code }) +
            "," +
            JSON.stringify(origin) +
            ");window.close();}</script>",
        );
      }
      res.writeHead(303, {
        Location: config.publicBase + "/?view=" + flow.view,
        "Set-Cookie": [
          cookie(
            "relay_session",
            sid,
            Math.floor((expires - Date.now()) / 1000),
          ),
          cookie("relay_flow", "", 0),
          `relay_embed_session=; Path=${prefix}; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0`,
        ],
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      return res.end();
    }
    if (path === "/auth/finish-embed" && req.method === "POST") {
      if (
        req.headers.origin !== origin ||
        req.headers["content-type"] !== "application/json"
      )
        throw fail(403, "请求来源无效");
      const v = await body(req, 2048);
      if (
        Object.keys(v).sort().join(",") !== "code,verifier" ||
        !/^[\w-]{43}$/.test(v.code || "") ||
        !/^[\w-]{43}$/.test(v.verifier || "")
      )
        throw fail(400, "登录交接无效");
      const challenge = createHash("sha256")
        .update(v.verifier)
        .digest("base64url");
      const transfer = db
        .prepare(
          "DELETE FROM handoffs WHERE code_hash=? AND challenge=? AND expires>? RETURNING *",
        )
        .get(hash(v.code), challenge, Date.now());
      if (!transfer) throw fail(401, "登录交接已失效，请重新登录");
      const saved = open(transfer.encrypted, hash(v.code)),
        p = await identity.inspect(saved.token);
      if (p.subject !== saved.subject || p.tenantKey !== config.tenantKey)
        throw fail(401, "身份不匹配");
      const sid = nonce(),
        id = hash(sid),
        expires = Math.min(Date.parse(p.expiresAt), Date.now() + 8 * 3600000);
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        id,
        seal(saved, id),
        expires,
      );
      res.setHeader(
        "Set-Cookie",
        `relay_embed_session=${sid}; Path=${prefix}; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=${Math.floor((expires - Date.now()) / 1000)}`,
      );
      return json(res, 200, { connected: true });
    }
    if (path === "/auth/logout" && req.method === "POST") {
      if (req.headers.origin !== origin) throw fail(403, "请求来源无效");
      const sid =
        cookies(req).relay_embed_session || cookies(req).relay_session;
      if (sid && /^[\w-]{43}$/.test(sid)) {
        const id = hash(sid),
          row = db
            .prepare("DELETE FROM sessions WHERE id_hash=? RETURNING encrypted")
            .get(id);
        sessionCache.delete(id);
        if (row) {
          const saved = open(row.encrypted, id);
          if (saved.token) await identity.revoke(saved.token).catch(() => {});
        }
      }
      res.setHeader("Set-Cookie", [
        cookie("relay_session", "", 0),
        `relay_embed_session=; Path=${prefix}; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0`,
      ]);
      return json(res, 200, { loggedOut: true });
    }
    if (path.startsWith("/api/")) {
      if (
        !["GET", "HEAD"].includes(req.method) &&
        (req.headers.origin !== origin ||
          !String(req.headers["content-type"] || "").startsWith(
            "application/json",
          ))
      )
        throw fail(403, "请求来源无效");
      const a = await actor(req);
      if (
        a.relayCustomer &&
        (u.searchParams.get("view") === "operator" ||
          u.searchParams.get("client") === "relay" ||
          !(
            path === "/api/relay/profile" ||
            path === "/api/support/profile" ||
            path === "/api/relay/state" ||
            path === "/api/relay/unread" ||
            path === "/api/relay/conversations" ||
            /^\/api\/relay\/conversations\/[\w-]+\/(messages|read)$/.test(
              path,
            ) ||
            /^\/api\/relay\/attachments\/[\w-]+\/\d+$/.test(path)
          ))
      )
        throw fail(403, "客服会话权限不足");
      return await api(path, req, res, u, a);
    }
    if (!["GET", "HEAD"].includes(req.method)) throw fail(405, "请求方式无效");
    const name =
        path.startsWith("/assets/") || path === "/unread.html"
          ? path
          : "/index.html",
      filename = resolve(publicDirectory, "." + name);
    if (!filename.startsWith(publicDirectory + "/"))
      throw fail(404, "资源不存在");
    let bytes;
    try {
      if (!realpathSync(filename).startsWith(publicDirectory + "/"))
        throw Error();
      bytes = readFileSync(filename);
    } catch {
      throw fail(404, "资源不存在");
    }
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https://internal.110-lab.cn data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://internal.110-lab.cn https://fcncvoyreb8p.feishuapp.com https://knowledge.110-lab.cn https://exam.110-lab.cn https://aigrading.110-lab.cn",
    );
    res.writeHead(200, {
      "Content-Type": types[extname(filename)] || "application/octet-stream",
      "Cache-Control": name.endsWith(".html")
        ? "no-store"
        : "public, max-age=3600",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch (e) {
    req.resume();
    if (!res.headersSent) {
      const status =
        typeof e.getStatus === "function"
          ? e.getStatus()
          : e.status || (e.name === "ZodError" ? 400 : 503);
      json(res, status, {
        message: status >= 500 ? "服务暂不可用，请重试" : e.message,
        loginPath: status === 401 ? prefix + "/auth/start" : undefined,
      });
    } else res.end();
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(Number(process.env.RELAY_PORT || 18462), "127.0.0.1", () => {
  console.log("Relay intranet application ready");
  notices.start();
  consultations.start();
  reminders.start();
  ai.start();
});
const cleanup = setInterval(() => {
  db.prepare("DELETE FROM handoffs WHERE expires<?").run(Date.now());
  db.prepare("DELETE FROM flows WHERE expires<?").run(Date.now() - 600000);
  db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
}, 60000);
cleanup.unref();
process.once("SIGTERM", async () => {
  clearInterval(cleanup);
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    notices.stop(),
    consultations.stop(),
    reminders.stop(),
    ai.stop(),
  ]);
  store.close();
  process.exit(0);
});
