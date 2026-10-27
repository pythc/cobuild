// Executed only by tools/test_local_suite.py with disposable loopback services.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
const config = JSON.parse(readFileSync(process.env.COBUILD_CONFIG)),
  base = config.origins.platform;
const jars = new Map();
let checks = 0;
async function request(
  url,
  { jar = "owner", body, method = body ? "POST" : "GET", headers = {} } = {},
) {
  const origin = new URL(url).origin,
    key = jar + origin,
    cookies = jars.get(key) || new Map();
  const r = await fetch(url, {
    redirect: "manual",
    method,
    headers: {
      ...(cookies.size
        ? { Cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; ") }
        : {}),
      ...(body ? { "Content-Type": "application/json", Origin: origin } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  for (const c of r.headers.getSetCookie()) {
    const [pair] = c.split(";"),
      i = pair.indexOf("=");
    if (/max-age=0(?:;|$)/i.test(c)) cookies.delete(pair.slice(0, i));
    else cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  jars.set(key, cookies);
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, headers: r.headers, data, text };
}
function check(value, message) {
  assert.ok(value, message);
  checks++;
}
const post = (path, body, csrf, jar = "owner") =>
  request(base + path, {
    jar,
    body,
    headers: csrf ? { "X-CSRF-Token": csrf } : {},
  });
const setup = await post(
  "/api/auth/bootstrap",
  {
    email: "owner@example.test",
    name: "Suite Owner",
    password: "Only a generated local test password",
  },
  undefined,
);
check(setup.status === 403, "setup must require private key");
const key = readFileSync(
  join(process.env.COBUILD_DATA_DIR, "bootstrap.private.key"),
  "utf8",
).trim();
let result = await request(base + "/api/auth/bootstrap", {
  body: {
    email: "owner@example.test",
    name: "Suite Owner",
    password: "Only a generated local test password",
  },
  headers: { "X-Bootstrap-Token": key },
});
check(result.status === 200, "owner bootstrap");
let owner = result.data;
check(
  owner.role === "super_admin" && owner.provider === "local",
  "generic local identity",
);
result = await post(
  "/api/organization/invitations",
  { email: "member@example.test" },
  owner.csrf,
);
check(result.status === 201, "invite member");
result = await post(
  "/api/auth/accept",
  {
    token: result.data.token,
    name: "Suite Member",
    password: "Member local test password 123",
  },
  undefined,
  "member",
);
check(result.status === 200, "accept invited member");
let member = result.data;
check(member.role === "member", "invitation must not grant administrator");
check(
  (await request(base + "/organization")).status === 200,
  "native organization page",
);
check(
  (await request(base + "/organization", { jar: "member" })).status === 403,
  "member cannot manage organization",
);
check(
  (
    await post(
      "/api/organization/invitations",
      { email: "blocked@example.test" },
      member.csrf,
      "member",
    )
  ).status === 403,
  "member cannot invite",
);
check(
  (
    await request(base + "/api/auth/logout", {
      body: {},
      headers: {
        Origin: "https://attacker.invalid",
        "X-CSRF-Token": owner.csrf,
      },
    })
  ).status === 403,
  "cross-origin logout blocked",
);
check(
  (await post("/api/auth/logout", {}, "wrong")).status === 403,
  "CSRF required",
);
const state = randomBytes(32).toString("base64url"),
  verifier = randomBytes(32).toString("base64url"),
  challenge = createHash("sha256").update(verifier).digest("base64url"),
  redirectUri = config.origins.makit + "/callback/110lab_requirements";
check(
  (
    await post(
      "/api/identity/authorize",
      {
        audience: "requirements",
        state,
        challenge,
        redirectUri: "https://attacker.invalid/callback",
      },
      owner.csrf,
    )
  ).status === 400,
  "exact callback required",
);
result = await post(
  "/api/identity/authorize",
  { audience: "requirements", state, challenge, redirectUri },
  owner.csrf,
);
const code = new URL(result.data.redirectUrl).searchParams.get("code");
async function exchange(input) {
  const response = await fetch(base + "/api/identity/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await response.body?.cancel();
  return response.status;
}
const exchangeInput = {
  audience: "requirements",
  state,
  code,
  verifier,
  redirectUri,
};
check(
  (await exchange({
    ...exchangeInput,
    verifier: randomBytes(32).toString("base64url"),
  })) === 401,
  "wrong PKCE rejected",
);
check((await exchange(exchangeInput)) === 200, "correct PKCE exchanged once");
check(
  (await exchange(exchangeInput)) === 401,
  "authorization code replay rejected",
);
for (const path of [
  "/recruitment",
  "/honors",
  "/mail",
  "/monitoring",
  "/api/recruitment-workflow/session",
  "/api/honors/session",
  "/apps/enter/assessment",
  "/apps/enter/relay",
  "/api/admin/session",
])
  check((await request(base + path)).status === 404, "disabled route " + path);
const rpc = (body) =>
  request(base + "/mcp", {
    body,
    headers: { Accept: "application/json, text/event-stream" },
  });
result = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
check(
  result.status === 200 &&
    result.data?.result?.tools?.some((t) => t.name === "lab_projects_list"),
  "MCP project tools available",
);
check(
  !result.data.result.tools.some((t) =>
    /^lab_(recruitment|mail|honors|updates)_/.test(t.name),
  ),
  "disabled MCP tools absent",
);
result = await rpc({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "lab_honors_list", arguments: {} },
});
check(result.data?.error?.code === -32601, "direct disabled MCP call blocked");
async function sso(app, jar = "owner") {
  const url = config.origins[app],
    audience = app === "makit" ? "requirements" : "knowledge";
  const flow = await request(
    url + (app === "makit" ? "/auth/start" : "/api/auth/identity/login"),
    { jar },
  );
  check(flow.status === 302, app + " starts generic identity login");
  const u = new URL(flow.headers.get("location"));
  check(u.origin === base, app + " uses configured issuer");
  const consent = await request(u.href, { jar });
  check(
    consent.status === 200 && consent.text.includes("CoBuild"),
    app + " consent page",
  );
  const session = await request(base + "/api/auth/session", { jar });
  const authorization = await post(
    "/api/identity/authorize",
    {
      audience,
      redirectUri: u.searchParams.get("redirect_uri"),
      state: u.searchParams.get("state"),
      challenge: u.searchParams.get("code_challenge"),
    },
    session.data.csrf,
    jar,
  );
  check(authorization.status === 200, app + " central authorization");
  const completed = await request(authorization.data.redirectUrl, { jar });
  check(
    completed.status === 303 || (app === "weknow" && completed.status === 302),
    app + " callback completed",
  );
  check(
    !completed.headers.get("location")?.includes("error="),
    app + " callback not redirected to error",
  );
  const me = await request(
    url + (app === "makit" ? "/api/selfhost/session" : "/api/users/me"),
    { jar, ...(app === "weknow" ? { body: {} } : {}) },
  );
  check(me.status === 200, app + " authenticated API");
  return me.data;
}
const makitOwner = await sso("makit"),
  weknowOwner = await sso("weknow");
check(
  makitOwner.roles?.includes("admin"),
  "first Makit account initialized by owner",
);
check(
  (weknowOwner.data || weknowOwner).user?.role === "owner",
  "first WeKnow owner initialized",
);
const makitMember = await sso("makit", "member"),
  weknowMember = await sso("weknow", "member");
check(!makitMember.roles?.includes("admin"), "member not promoted in Makit");
check(
  (weknowMember.data || weknowMember).user?.role !== "owner",
  "member not promoted in WeKnow",
);
await post(
  "/api/organization/users/" + member.id,
  { role: "admin" },
  owner.csrf,
);
const retained = await request(config.origins.makit + "/api/selfhost/session", {
  jar: "member",
});
check(
  retained.status === 200 && !retained.data.roles.includes("admin"),
  "central role change does not rewrite business role",
);
result = await post("/api/auth/logout", {}, member.csrf, "member");
check(result.status === 200, "central logout");
check(
  (
    await request(config.origins.makit + "/api/selfhost/session", {
      jar: "member",
    })
  ).status === 401,
  "Makit rejects central logout immediately",
);
check(
  (
    await request(config.origins.weknow + "/api/users/me", {
      jar: "member",
      body: {},
    })
  ).status === 401,
  "WeKnow rejects central logout immediately",
);
result = await post(
  "/api/auth/login",
  { email: "member@example.test", password: "Member local test password 123" },
  undefined,
  "member",
);
member = { ...member, ...result.data };
await sso("makit", "member");
await sso("weknow", "member");
check(
  (
    await post(
      "/api/organization/users/" + member.id,
      { active: false },
      owner.csrf,
    )
  ).status === 200,
  "owner suspends member",
);
check(
  (
    await request(config.origins.makit + "/api/selfhost/session", {
      jar: "member",
    })
  ).status === 401,
  "Makit rejects suspension",
);
check(
  (
    await request(config.origins.weknow + "/api/users/me", {
      jar: "member",
      body: {},
    })
  ).status === 401,
  "WeKnow rejects suspension",
);
check(
  (
    await post(
      "/api/organization/users/" + member.id,
      { active: true },
      owner.csrf,
    )
  ).status === 200,
  "owner reactivates member",
);
check(
  (await request(base + "/api/auth/session", { jar: "member" })).status === 401,
  "reactivation does not resurrect old session",
);
console.log(
  JSON.stringify({
    passed: true,
    checks,
    scope: "native platform + real Makit and WeKnow HTTP SSO",
    externalMessages: false,
  }),
);
