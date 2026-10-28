import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
  scrypt as rawScrypt,
} from "node:crypto";
import { promisify } from "node:util";
import {
  mkdirSync,
  lstatSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { MailAuthError } from "./mail-auth.mjs";

const scrypt = promisify(rawScrypt),
  nonce = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const validEmail = (value) =>
  typeof value === "string" &&
  value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const safePassword = (password) =>
  typeof password === "string" &&
  password.length >= 12 &&
  password.length <= 128 &&
  Buffer.byteLength(password) <= 512;
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.mode & 0o077)
    throw new Error("Identity storage must be a private directory");
}
function privateFile(path) {
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077)
    throw new Error("Unsafe identity storage file");
}
export function openSuiteAuth({ directory, config, now = Date.now }) {
  privateDirectory(directory);
  const filename = join(directory, "identity.sqlite");
  privateFile(filename);
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec(`PRAGMA busy_timeout=3000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS suite_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS suite_users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('super_admin','admin','member')),active INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS suite_sessions(key TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES suite_users(id),csrf TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS suite_invitations(key TEXT PRIMARY KEY,email TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('admin','member')),expires INTEGER NOT NULL,created_by TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS suite_api_tokens(key TEXT PRIMARY KEY,session_key TEXT NOT NULL,scopes TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS suite_login_budget(key TEXT NOT NULL,bucket INTEGER NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(key,bucket));
    CREATE TABLE IF NOT EXISTS suite_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT,action TEXT NOT NULL,target TEXT,created INTEGER NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS suite_recovery(key TEXT PRIMARY KEY,user_id TEXT NOT NULL,created_by TEXT,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS suite_owner_transfer(id INTEGER PRIMARY KEY CHECK(id=1),source TEXT NOT NULL,target TEXT NOT NULL,expires INTEGER NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO suite_meta VALUES(?,?)").run(
    "organizationId",
    randomUUID(),
  );
  const organizationId = db
    .prepare("SELECT value FROM suite_meta WHERE key=?")
    .get("organizationId").value;
  const cookieName = config.origins.platform.startsWith("https:")
    ? "__Host-cobuild_session"
    : "cobuild_dev_session";
  const cookie = (value, age = config.identity.sessionDays * 86400) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.origins.platform.startsWith("https:") ? "; Secure" : ""}`;
  const bootstrapFile = join(directory, "bootstrap.private.key");
  const userCount = () =>
    db.prepare("SELECT count(*) n FROM suite_users").get().n;
  if (userCount() === 0) {
    privateFile(bootstrapFile);
    if (!existsSync(bootstrapFile)) {
      const value = nonce();
      writeFileSync(bootstrapFile, value + "\n", { mode: 0o600, flag: "wx" });
    }
    const value = readFileSync(bootstrapFile, "utf8").trim();
    if (!/^[\w-]{43}$/.test(value))
      throw new Error("Invalid bootstrap credential");
    db.prepare("INSERT OR REPLACE INTO suite_meta VALUES(?,?)").run(
      "bootstrapHash",
      hash(value),
    );
  } else if (existsSync(bootstrapFile)) {
    privateFile(bootstrapFile);
    unlinkSync(bootstrapFile);
  }
  const audit = (actor, action, target) =>
    db
      .prepare(
        "INSERT INTO suite_audit(actor,action,target,created) VALUES(?,?,?,?)",
      )
      .run(actor, action, target, now());
  const transaction = (operation) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const subject = (id) => organizationId + ":" + id;
  function profile(value) {
    if (typeof value !== "string" || value.length > 100)
      throw new MailAuthError(401, "账号不可用或登录已失效");
    const id = value?.startsWith(organizationId + ":")
      ? value.slice(organizationId.length + 1)
      : value;
    const row = db
      .prepare(
        "SELECT id,email,name,role,active FROM suite_users WHERE id=? AND active=1",
      )
      .get(id);
    if (!row) throw new MailAuthError(401, "账号不可用或登录已失效");
    return {
      subject: subject(row.id),
      id: row.id,
      userId: row.id,
      unionId: row.id,
      employeeId: row.id,
      openId: row.id,
      tenantKey: organizationId,
      organizationId,
      name: row.name,
      email: row.email,
      role: row.role,
      provider: "local",
    };
  }
  const administrator = (actor) => {
    const current = profile(actor.subject);
    if (!["admin", "super_admin"].includes(current.role))
      throw new MailAuthError(403, "需要组织管理员权限");
    return current;
  };
  const owner = (actor) => {
    const current = profile(actor.subject);
    if (current.role !== "super_admin")
      throw new MailAuthError(403, "需要组织所有者权限");
    return current;
  };
  function budget(ip, email) {
    const bucket = Math.floor(now() / 900000);
    for (const [key, max] of [
      [hash("ip:" + ip), 50],
      [hash("account:" + email), 15],
    ]) {
      const count = db
        .prepare(
          "INSERT INTO suite_login_budget VALUES(?,?,1) ON CONFLICT(key,bucket) DO UPDATE SET n=n+1 RETURNING n",
        )
        .get(key, bucket).n;
      if (count > max) throw new MailAuthError(429, "登录尝试较多，请稍后再试");
    }
    db.prepare("DELETE FROM suite_login_budget WHERE bucket<?").run(bucket - 4);
  }
  async function passwordHash(password) {
    if (!safePassword(password))
      throw new MailAuthError(400, "密码需要 12 至 128 个字符");
    const salt = randomBytes(16).toString("hex");
    const result = await scrypt(password, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return salt + ":" + result.toString("hex");
  }
  async function passwordMatches(password, stored) {
    const [salt, expected] = stored.split(":");
    const actual = await scrypt(password, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return same(actual.toString("hex"), expected);
  }
  function validateUser(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["email", "name", "password"].includes(k),
      ) ||
      !validEmail(input.email) ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 100 ||
      /[\x00-\x1f]/.test(input.name)
    )
      throw new MailAuthError(400, "姓名或邮箱格式无效");
  }
  function mint(id) {
    const token = nonce(),
      csrf = nonce(),
      created = now(),
      expires = created + config.identity.sessionDays * 86400000;
    db.prepare("INSERT INTO suite_sessions VALUES(?,?,?,?,?)").run(
      hash(token),
      id,
      csrf,
      created,
      expires,
    );
    return {
      cookie: cookie(token),
      session: {
        key: hash(token),
        subject: subject(id),
        csrf,
        created,
        expiresAt: new Date(expires).toISOString(),
      },
    };
  }
  function sessionByKey(key) {
    const row = db
      .prepare("SELECT * FROM suite_sessions WHERE key=? AND expires>?")
      .get(key, now());
    if (!row) throw new MailAuthError(401, "请登录 CoBuild");
    profile(row.user_id);
    return {
      key: row.key,
      subject: subject(row.user_id),
      csrf: row.csrf,
      created: row.created,
      expiresAt: new Date(row.expires).toISOString(),
    };
  }
  function revokeUser(id) {
    db.prepare(
      "DELETE FROM suite_api_tokens WHERE session_key IN (SELECT key FROM suite_sessions WHERE user_id=?)",
    ).run(id);
    db.prepare("DELETE FROM suite_sessions WHERE user_id=?").run(id);
    db.prepare(
      "DELETE FROM suite_recovery WHERE user_id=? OR created_by=?",
    ).run(id, id);
    db.prepare("DELETE FROM suite_invitations WHERE created_by=?").run(id);
    db.prepare(
      "DELETE FROM suite_owner_transfer WHERE source=? OR target=?",
    ).run(id, id);
  }
  async function confirmPassword(session, password) {
    const current = sessionByKey(session.key),
      p = profile(current.subject);
    budget("reauth:" + p.id, p.email);
    const row = db
      .prepare("SELECT password FROM suite_users WHERE id=?")
      .get(p.id);
    if (
      typeof password !== "string" ||
      password.length > 128 ||
      !(await passwordMatches(password, row.password))
    )
      throw new MailAuthError(403, "当前密码不正确");
    // scrypt yields; recheck suspension, reset, logout and a competing password change.
    sessionByKey(session.key);
    if (
      db.prepare("SELECT password FROM suite_users WHERE id=?").get(p.id)
        ?.password !== row.password
    )
      throw new MailAuthError(401, "身份已改变，请重新登录");
    return profile(p.id);
  }
  function recovery(id, actorId) {
    const token = nonce(),
      expires = now() + 30 * 60000;
    db.prepare("DELETE FROM suite_recovery WHERE user_id=?").run(id);
    db.prepare("INSERT INTO suite_recovery VALUES(?,?,?,?)").run(
      hash(token),
      id,
      actorId,
      expires,
    );
    audit(actorId, "identity.recovery.issued", id);
    return { token, expiresAt: new Date(expires).toISOString() };
  }
  return {
    organizationId,
    bootstrapFile,
    cookieName,
    profile,
    administrator,
    owner,
    sessionByKey,
    initialized: () => userCount() > 0,
    directorySnapshot() {
      return {
        organizationId,
        members: db
          .prepare(
            "SELECT id,email,name,role,active FROM suite_users ORDER BY id",
          )
          .all()
          .map((r) => ({
            ...r,
            active: Boolean(r.active),
            subject: subject(r.id),
          })),
      };
    },
    async changePassword(session, input) {
      if (
        !input ||
        Object.keys(input).some(
          (k) => !["currentPassword", "password"].includes(k),
        )
      )
        throw new MailAuthError(400, "参数无效");
      const p = await confirmPassword(session, input.currentPassword),
        encoded = await passwordHash(input.password);
      sessionByKey(session.key);
      transaction(() => {
        db.prepare("UPDATE suite_users SET password=? WHERE id=?").run(
          encoded,
          p.id,
        );
        revokeUser(p.id);
        audit(p.id, "identity.password.changed", p.id);
      });
      return { changed: true };
    },
    async issueRecovery(session, input) {
      if (
        !input ||
        Object.keys(input).some(
          (k) => !["userId", "currentPassword"].includes(k),
        ) ||
        typeof input.userId !== "string"
      )
        throw new MailAuthError(400, "参数无效");
      const p = await confirmPassword(session, input.currentPassword),
        current = administrator(p),
        target = profile(input.userId);
      if (
        target.role === "super_admin" ||
        target.id === current.id ||
        (current.role !== "super_admin" && target.role !== "member")
      )
        throw new MailAuthError(403, "只能为权限低于自己的成员生成恢复链接");
      return recovery(target.id, current.id);
    },
    // Local CLI only. Possession of the private identity directory is required.
    recoverOwner() {
      const rows = db
        .prepare(
          "SELECT id FROM suite_users WHERE role='super_admin' AND active=1",
        )
        .all();
      if (rows.length !== 1) throw new MailAuthError(409, "组织所有者状态异常");
      return recovery(rows[0].id, null);
    },
    async resetPassword(input, ip) {
      if (
        !input ||
        Object.keys(input).some((k) => !["token", "password"].includes(k)) ||
        !/^[\w-]{43}$/.test(input.token || "")
      )
        throw new MailAuthError(400, "恢复链接无效");
      budget("reset:" + ip, hash(input.token));
      const encoded = await passwordHash(input.password);
      transaction(() => {
        const row = db
          .prepare("SELECT * FROM suite_recovery WHERE key=? AND expires>?")
          .get(hash(input.token), now());
        if (!row) throw new MailAuthError(410, "恢复链接已失效");
        const target = profile(row.user_id);
        if (row.created_by) {
          const p = administrator(profile(row.created_by));
          if (
            target.role === "super_admin" ||
            (p.role !== "super_admin" && target.role !== "member")
          )
            throw new MailAuthError(403, "恢复授权已失效");
        } else if (target.role !== "super_admin")
          throw new MailAuthError(403, "所有者已变更");
        db.prepare("UPDATE suite_users SET password=? WHERE id=?").run(
          encoded,
          target.id,
        );
        revokeUser(target.id);
        audit(target.id, "identity.password.recovered", target.id);
      });
      return { changed: true };
    },
    transferStatus(actor) {
      const p = profile(actor.subject),
        row = db
          .prepare(
            "SELECT source,target,expires FROM suite_owner_transfer WHERE id=1 AND expires>?",
          )
          .get(now());
      return row && [row.source, row.target].includes(p.id)
        ? { ...row, targetName: profile(row.target).name }
        : null;
    },
    async transferOwner(session, input) {
      if (
        !input ||
        Object.keys(input).some(
          (k) => !["action", "userId", "currentPassword"].includes(k),
        ) ||
        !["request", "accept", "cancel"].includes(input.action) ||
        (input.action === "request" && typeof input.userId !== "string")
      )
        throw new MailAuthError(400, "转让参数无效");
      const p = await confirmPassword(session, input.currentPassword);
      return transaction(() => {
        if (input.action === "request") {
          owner(p);
          const target = profile(input.userId);
          if (target.id === p.id)
            throw new MailAuthError(400, "请选择其他成员");
          db.prepare(
            "INSERT OR REPLACE INTO suite_owner_transfer VALUES(1,?,?,?)",
          ).run(p.id, target.id, now() + 86400000);
          audit(p.id, "organization.transfer.requested", target.id);
          return { pending: true };
        }
        const row = db
          .prepare(
            "SELECT * FROM suite_owner_transfer WHERE id=1 AND expires>?",
          )
          .get(now());
        if (!row) throw new MailAuthError(410, "转让邀请已失效");
        owner(profile(row.source));
        if (input.action === "cancel") {
          if (![row.source, row.target].includes(p.id))
            throw new MailAuthError(403, "没有权限");
          db.prepare("DELETE FROM suite_owner_transfer WHERE id=1").run();
          audit(p.id, "organization.transfer.cancelled", row.target);
          return { cancelled: true };
        }
        if (p.id !== row.target)
          throw new MailAuthError(403, "仅被指定的成员可接收");
        db.prepare("UPDATE suite_users SET role='admin' WHERE id=?").run(
          row.source,
        );
        db.prepare("UPDATE suite_users SET role='super_admin' WHERE id=?").run(
          p.id,
        );
        revokeUser(row.source);
        revokeUser(p.id);
        audit(p.id, "organization.transfer.accepted", row.source);
        return { transferred: true };
      });
    },
    issueToken(session, scopes) {
      sessionByKey(session.key);
      const token = nonce();
      db.prepare("INSERT INTO suite_api_tokens VALUES(?,?,?,?)").run(
        hash(token),
        session.key,
        JSON.stringify(scopes),
        now(),
      );
      audit(session.subject, "identity.api-token.created", null);
      return { token, scopes, expiresAt: session.expiresAt };
    },
    inspectToken(token) {
      if (!/^[\w-]{43}$/.test(token || ""))
        throw new MailAuthError(401, "个人访问令牌无效");
      const row = db
        .prepare("SELECT * FROM suite_api_tokens WHERE key=?")
        .get(hash(token));
      if (!row) throw new MailAuthError(401, "个人访问令牌无效");
      const session = sessionByKey(row.session_key);
      return { ...profile(session.subject), scopes: JSON.parse(row.scopes) };
    },
    async bootstrap(input, key) {
      validateUser(input);
      if (
        !same(
          hash(String(key)),
          db
            .prepare("SELECT value FROM suite_meta WHERE key=?")
            .get("bootstrapHash")?.value || "",
        )
      )
        throw new MailAuthError(403, "初始化凭据无效");
      const password = await passwordHash(input.password),
        id = randomUUID();
      transaction(() => {
        if (userCount()) throw new MailAuthError(409, "组织已完成初始化");
        db.prepare("INSERT INTO suite_users VALUES(?,?,?,?,?,1,?)").run(
          id,
          input.email.toLowerCase(),
          input.name.trim(),
          password,
          "super_admin",
          now(),
        );
        db.prepare("DELETE FROM suite_meta WHERE key=?").run("bootstrapHash");
        audit(id, "organization.bootstrap", id);
      });
      unlinkSync(bootstrapFile);
      return mint(id);
    },
    async login(input, ip) {
      const email =
        typeof input?.email === "string" ? input.email.toLowerCase() : "";
      budget(ip, email);
      const password =
        typeof input?.password === "string" ? input.password : "";
      if (password.length > 128)
        throw new MailAuthError(401, "邮箱或密码不正确");
      const row = db
        .prepare("SELECT * FROM suite_users WHERE email=?")
        .get(email);
      const stored =
        row?.password ||
        "00000000000000000000000000000000:" + "".padEnd(128, "0");
      if (!(await passwordMatches(password, stored)) || !row?.active)
        throw new MailAuthError(401, "邮箱或密码不正确");
      const current = db
        .prepare("SELECT active,password FROM suite_users WHERE id=?")
        .get(row.id);
      if (!current?.active || current.password !== stored)
        throw new MailAuthError(401, "邮箱或密码不正确");
      audit(row.id, "identity.login", row.id);
      return mint(row.id);
    },
    session(header) {
      const values = String(header || "")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.startsWith(cookieName + "="));
      if (
        values.length !== 1 ||
        !/^[\w-]{43}$/.test(values[0].slice(cookieName.length + 1))
      )
        throw new MailAuthError(401, "请登录 CoBuild");
      return sessionByKey(hash(values[0].slice(cookieName.length + 1)));
    },
    csrf(session, value) {
      if (!same(session.csrf, value))
        throw new MailAuthError(403, "页面已失效，请重新加载");
    },
    recent(session) {
      if (now() - session.created > 300000)
        throw new MailAuthError(403, "请重新登录以确认身份");
    },
    logout(session) {
      db.prepare("DELETE FROM suite_sessions WHERE key=?").run(session.key);
      audit(session.subject, "identity.logout", session.subject);
      return cookie("", 0);
    },
    members() {
      return db
        .prepare("SELECT id FROM suite_users WHERE active=1 ORDER BY name,id")
        .all()
        .map((row) => profile(row.id));
    },
    managedMembers(actor) {
      administrator(actor);
      return db
        .prepare(
          "SELECT id,email,name,role,active FROM suite_users ORDER BY name,id",
        )
        .all()
        .map((row) => ({ ...row, active: Boolean(row.active) }));
    },
    invite(actor, input) {
      const current = administrator(actor);
      if (
        !input ||
        Object.keys(input).some((k) => !["email", "role"].includes(k)) ||
        !validEmail(input.email) ||
        !["member", "admin"].includes(input.role || "member")
      )
        throw new MailAuthError(400, "邀请信息无效");
      if (input.role === "admin" && current.role !== "super_admin")
        throw new MailAuthError(403, "仅组织所有者可以邀请管理员");
      if (
        db
          .prepare("SELECT 1 FROM suite_users WHERE email=?")
          .get(input.email.toLowerCase())
      )
        throw new MailAuthError(409, "账号已存在");
      const token = nonce();
      db.prepare("INSERT INTO suite_invitations VALUES(?,?,?,?,?)").run(
        hash(token),
        input.email.toLowerCase(),
        input.role || "member",
        now() + 7 * 86400000,
        current.id,
      );
      audit(current.id, "identity.invite", input.email.toLowerCase());
      return { token, expiresAt: new Date(now() + 7 * 86400000).toISOString() };
    },
    async accept(input) {
      if (
        !input ||
        Object.keys(input).some(
          (k) => !["token", "name", "password"].includes(k),
        ) ||
        !/^[\w-]{43}$/.test(input.token || "")
      )
        throw new MailAuthError(400, "邀请无效");
      const invitation = db
        .prepare("SELECT * FROM suite_invitations WHERE key=? AND expires>?")
        .get(hash(input.token), now());
      if (!invitation) throw new MailAuthError(410, "邀请已失效");
      validateUser({
        email: invitation.email,
        name: input.name,
        password: input.password,
      });
      const password = await passwordHash(input.password),
        id = randomUUID();
      transaction(() => {
        const current = db
          .prepare(
            "DELETE FROM suite_invitations WHERE key=? AND expires>? RETURNING *",
          )
          .get(hash(input.token), now());
        if (!current) throw new MailAuthError(410, "邀请已失效");
        const inviter = administrator(profile(current.created_by));
        if (current.role === "admin" && inviter.role !== "super_admin")
          throw new MailAuthError(403, "邀请授权已改变");
        if (
          db
            .prepare("SELECT 1 FROM suite_users WHERE email=?")
            .get(current.email)
        )
          throw new MailAuthError(409, "账号已存在");
        db.prepare("INSERT INTO suite_users VALUES(?,?,?,?,?,1,?)").run(
          id,
          current.email,
          input.name.trim(),
          password,
          current.role,
          now(),
        );
        audit(id, "identity.invitation.accepted", current.created_by);
      });
      return mint(id);
    },
    updateMember(actor, id, input) {
      owner(actor);
      if (
        !input ||
        Object.keys(input).some((k) => !["role", "active"].includes(k)) ||
        (input.role !== undefined &&
          !["admin", "member"].includes(input.role)) ||
        (input.active !== undefined && typeof input.active !== "boolean")
      )
        throw new MailAuthError(400, "成员设置无效");
      const target = db.prepare("SELECT * FROM suite_users WHERE id=?").get(id);
      if (!target) throw new MailAuthError(404, "成员不存在");
      if (target.role === "super_admin")
        throw new MailAuthError(403, "不能停用或降级组织所有者");
      transaction(() => {
        db.prepare("UPDATE suite_users SET role=?,active=? WHERE id=?").run(
          input.role || target.role,
          input.active === undefined ? target.active : Number(input.active),
          id,
        );
        if (input.active === false) {
          revokeUser(id);
          db.prepare("DELETE FROM suite_sessions WHERE user_id=?").run(id);
          db.prepare("DELETE FROM suite_invitations WHERE created_by=?").run(
            id,
          );
        }
        audit(actor.subject, "identity.member.updated", id);
      });
      return { updated: true };
    },
    close() {
      db.close();
    },
  };
}
