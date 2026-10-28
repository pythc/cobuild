// Executed only by tools/test_local_suite.py with disposable loopback services.
import { serviceRequest } from "../packages/service/channel.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash, randomUUID } from "node:crypto";
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
// A member who never opened either application is already selectable.
result = await request(config.origins.makit + "/api/selfhost/users/search", {
  body: { query: "Suite Member" },
});
check(
  result.status === 201 || result.status === 200,
  "Makit directory request",
);
check(
  JSON.stringify(result.data).includes(member.id),
  "Makit directory contains an unlogged member",
);
result = await request(config.origins.weknow + "/api/workspace/members", {
  body: { query: "Suite Member", limit: 20 },
});
check(
  result.status === 200 &&
    JSON.stringify(result.data).includes("member@example.test"),
  "WeKnow directory contains an unlogged member",
);
const makitMember = await sso("makit", "member"),
  weknowMember = await sso("weknow", "member");
check(!makitMember.roles?.includes("admin"), "member not promoted in Makit");
check(
  (weknowMember.data || weknowMember).user?.role !== "owner",
  "member not promoted in WeKnow",
);
async function pollProject(id, predicate) {
  for (let i = 0; i < 250; i++) {
    const r = await request(base + "/api/workspace/projects/" + id);
    if (r.status === 200 && predicate(r.data)) return r.data;
    await new Promise((r) => setTimeout(r, 200));
  }
  const r = await request(base + "/api/workspace/projects/" + id);
  throw Error(
    "Project outbox did not settle: " +
      JSON.stringify({
        sync: r.data?.requirementsSync,
        knowledge: r.data?.knowledgeSpace,
      }),
  );
}
const createId = randomUUID();
const projectInput = {
  requestId: createId,
  name: "Portable Suite Project",
  summary: "Synthetic local collaboration acceptance",
  members: [
    { subject: member.subject, name: member.name, email: member.email },
  ],
  links: { repository: "", requirements: "", docs: "", demo: "" },
  createKnowledgeSpace: true,
};
result = await post("/api/workspace/projects", projectInput, owner.csrf);
check(result.status === 201, "Kick creates project " + result.status);
let project = result.data;
const projectId = project.id;
check(
  project.knowledgeSpace?.state === "awaiting_approval",
  "space must wait for approval",
);
result = await post("/api/workspace/projects", projectInput, owner.csrf);
check(
  result.status === 201 && result.data.id === projectId,
  "create replay retains project UUID",
);
project = (await request(base + "/api/workspace/projects/" + projectId)).data;
result = await post(
  "/api/workspace/projects/" + projectId + "/apply",
  { revision: project.revision, application: "Local acceptance project" },
  owner.csrf,
);
check(
  result.status === 200 && result.data.phase === "pending",
  "submit project for review",
);
project = result.data;
result = await post(
  "/api/workspace/projects/" + projectId + "/review",
  { revision: project.revision, decision: "approve", note: "" },
  member.csrf,
  "member",
);
check(result.status === 403, "member cannot approve project");
// Outbox acknowledgements can legitimately update revisions; use the current one.
project = (await request(base + "/api/workspace/projects/" + projectId)).data;
result = await post(
  "/api/workspace/projects/" + projectId + "/review",
  { revision: project.revision, decision: "approve", note: "" },
  owner.csrf,
);
check(result.status === 200, "approve project");
project = await pollProject(
  projectId,
  (p) =>
    p.knowledgeSpace?.state === "ready" &&
    p.requirementsSync?.state === "synced",
);
check(
  new URL(project.links.knowledgeSpace).origin === config.origins.weknow,
  "configured knowledge space link",
);
check(
  new URL(project.links.requirements).origin === config.origins.makit,
  "configured requirement project link",
);
result = await request(
  config.origins.makit + "/api/workspace/project-management",
);
let projected = (result.data?.data || result.data)?.projects?.find(
  (p) => p.projectId === projectId,
);
check(
  !!projected &&
    projected.snapshot.links.knowledgeSpace === project.links.knowledgeSpace,
  "Makit displays canonical project and knowledge link",
);
const action = (action, input, requestId = randomUUID(), jar = "owner") =>
  request(config.origins.makit + "/api/workspace/project-management/action", {
    jar,
    body: { projectId, requestId, action, input },
  });
result = await action(
  "milestone_add",
  { title: "Ship local collaboration", assignee: member.subject, dueAt: null },
  randomUUID(),
  "member",
);
check(result.status === 403, "non-owner project member cannot add milestone");
const milestoneRequest = randomUUID(),
  milestoneInput = {
    title: "Ship local collaboration",
    assignee: member.subject,
    dueAt: null,
  };
result = await action("milestone_add", milestoneInput, milestoneRequest);
check(
  result.status === 201 || result.status === 200,
  "Makit creates Kick milestone " + result.status,
);
project = result.data.data || result.data;
const milestone = project.milestones.find(
  (m) => m.title === milestoneInput.title,
);
check(!!milestone, "milestone stored in Kick");
result = await action("milestone_add", milestoneInput, milestoneRequest);
check(
  (result.data.data || result.data).milestones.length ===
    project.milestones.length,
  "milestone retry is idempotent",
);
result = await action(
  "milestone_set",
  { id: milestone.id, revision: milestone.revision, status: "done" },
  randomUUID(),
  "member",
);
check(
  result.status === 201 || result.status === 200,
  "assigned member completes milestone",
);
project = (await request(base + "/api/workspace/projects/" + projectId)).data;
check(
  project.milestones.find((m) => m.id === milestone.id).status === "done",
  "Makit mutation visible in Kick",
);
result = await action(
  "milestone_set",
  { id: milestone.id, revision: milestone.revision, status: "open" },
  randomUUID(),
  "member",
);
check(result.status === 409, "stale milestone update rejected");
result = await request(config.origins.makit + "/api/workspace/requirements", {
  body: {
    title: "Local integration requirement",
    project: projectInput.name,
    type: "产品需求",
    introduction: "No external delivery",
    acceptanceCriteria: "Local workflow can be verified",
    handlerLarkUserIds: [member.id],
  },
});
check(
  result.status === 201 || result.status === 200,
  "create requirement in linked project " +
    result.status +
    " " +
    JSON.stringify(result.data?.message || result.data?.error || ""),
);
const requirement = (result.data.data || result.data).recordId;
check(!!requirement, "requirement persisted with receipt");
const unwrap = (r) => r.data?.data || r.data;
result = await request(
  config.origins.makit + "/api/workspace/requirements/" + requirement,
  { jar: "member" },
);
check(result.status === 200, "member reads assigned requirement");
let detail = unwrap(result);
check(
  detail.requirement.handlers.some((p) => p.id === member.id),
  "native member assignment preserved",
);
const updateId = randomUUID(),
  updateInput = {
    clientMutationId: updateId,
    expectedUpdatedAt: detail.requirement.updatedAt,
    patch: { latestProgress: "Implementation verified locally", effort: 2 },
  };
const submit = () =>
  request(config.origins.makit + "/api/workspace/requirements/" + requirement, {
    jar: "member",
    method: "PATCH",
    body: updateInput,
  });
result = await submit();
check(
  result.status === 200,
  "member submits requirement update " +
    result.status +
    " " +
    JSON.stringify(result.data?.message || ""),
);
const jobId = unwrap(result).jobId;
check(!!jobId, "update has durable operation ID");
result = await submit();
check(
  unwrap(result).jobId === jobId,
  "requirement update replay returns same job",
);
for (let i = 0; i < 100; i++) {
  result = await request(
    config.origins.makit + "/api/workspace/requirement-update-jobs/" + jobId,
    { jar: "member" },
  );
  if (["succeeded", "failed", "unknown"].includes(unwrap(result)?.status))
    break;
  await new Promise((r) => setTimeout(r, 200));
}
check(
  unwrap(result)?.status === "succeeded",
  "native update worker finishes " + JSON.stringify(unwrap(result)),
);
result = await request(
  config.origins.makit + "/api/workspace/requirements/" + requirement,
  { jar: "member" },
);
detail = unwrap(result);
check(
  detail.requirement.latestProgress === "Implementation verified locally" &&
    detail.requirement.effort === 2,
  "requirement update is persisted",
);
result = await request(
  config.origins.makit +
    "/api/workspace/requirements/" +
    requirement +
    "/comments",
  { jar: "member", body: { content: "Ready for review" } },
);
check(result.status === 201, "member comments on requirement");
result = await request(
  config.origins.makit +
    "/api/workspace/requirements/" +
    requirement +
    "/acceptance",
  {
    body: {
      title: "Core flow works",
      ownerUserIds: [makitMember.user_id],
      note: "Local synthetic test",
    },
  },
);
check(result.status === 201, "owner creates acceptance check " + result.status);
const acceptanceId = unwrap(result).recordId;
result = await request(
  config.origins.makit + "/api/workspace/acceptance/" + acceptanceId,
  { method: "PATCH", body: { completed: true } },
);
check(result.status === 200, "complete requirement acceptance item");
for (let i = 0; i < 100; i++) {
  result = await request(config.origins.makit + "/api/operations/progress", {
    jar: "member",
  });
  const row = unwrap(result)?.items?.find((v) => v.id === jobId);
  if (
    row?.result?.operationStages.some(
      (v) => v.key === "history" && v.status === "succeeded",
    ) &&
    row.result.operationStages
      .filter((v) => ["review", "notification"].includes(v.key))
      .every((v) => v.status === "disabled")
  )
    break;
  await new Promise((r) => setTimeout(r, 200));
}
const operation = unwrap(result)?.items?.find((v) => v.id === jobId);
check(
  /^REQ-\d{6,30}$/.test(detail.requirement.code),
  "native requirement code supports operation filters",
);
const filteredOperations = await request(
  config.origins.makit +
    "/api/operations/progress?requirementCode=" +
    encodeURIComponent(detail.requirement.code),
  { jar: "member" },
);
check(
  filteredOperations.status === 200 &&
    unwrap(filteredOperations)?.items?.some((v) => v.id === jobId),
  "operation history found by generated requirement code",
);
check(
  operation?.result?.operationStages.some(
    (v) => v.key === "history" && v.status === "succeeded",
  ),
  "confirmed change history is recorded",
);
check(
  operation?.result?.operationStages
    .filter((v) => ["review", "notification"].includes(v.key))
    .every((v) => v.status === "disabled"),
  "unconfigured integrations show disabled, never delivery success",
);

result = await request(config.origins.weknow + "/api/pages/create", {
  jar: "member",
  body: {
    spaceId: project.knowledgeSpace.spaceId,
    title: "Project design",
    content: "# Design\n\nShared local project documentation.",
    format: "markdown",
  },
});
check(
  result.status === 200 || result.status === 201,
  "project member writes knowledge page " + result.status,
);
const page = result.data.data || result.data;
check(!!page.id, "knowledge page has persistent ID");
const receipts = await Promise.all(
  [1, 2].map(() =>
    serviceRequest(
      config.origins.weknow,
      "/api/suite/projects/ensure",
      { organizationId: owner.organizationId, projectId },
      join(process.env.COBUILD_DATA_DIR, "weknow.service.key"),
    ),
  ),
);
check(
  receipts.every(
    (v) => (v.data || v).spaceId === project.knowledgeSpace.spaceId,
  ),
  "concurrent space retries retain one mapped space",
);

result = await request(config.origins.weknow + "/api/pages/info", {
  body: { pageId: page.id },
});
check(result.status === 200, "owner reads member project document");
// HTTP service routes must not accept a browser request or an unsigned body.
result = await request(base + "/api/suite/services/makit/directory", {
  body: { organizationId: owner.organizationId },
});
check(result.status === 401, "directory service signature required");
result = await request(config.origins.weknow + "/api/suite/projects/ensure", {
  body: { projectId },
});
check(result.status === 401, "space creation is not a public endpoint");
result = await request(
  config.origins.makit + "/openapi/workspace/projects/sync",
  { body: { sourceProjectId: projectId } },
);
check(result.status === 401, "project sync service signature required");
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
// Recovery works without a mail provider and invalidates old credentials.
result = await post(
  "/api/auth/recovery",
  {
    userId: member.id,
    currentPassword: "Only a generated local test password",
  },
  owner.csrf,
);
check(
  result.status === 200 && !!result.data.token,
  "owner generates recovery link",
);
const resetToken = result.data.token;
result = await post(
  "/api/auth/reset-password",
  { token: resetToken, password: "Recovered member local password 123" },
  undefined,
  "member",
);
check(result.status === 200, "member consumes recovery link");
result = await post(
  "/api/auth/reset-password",
  { token: resetToken, password: "Another recovered password 123" },
  undefined,
  "member",
);
check(result.status === 410, "used recovery token is rejected");
result = await post(
  "/api/auth/login",
  {
    email: "member@example.test",
    password: "Recovered member local password 123",
  },
  undefined,
  "member",
);
member = { ...member, ...result.data };
check(result.status === 200, "member logs in with recovered password");
result = await post(
  "/api/auth/transfer-owner",
  {
    action: "request",
    userId: member.id,
    currentPassword: "Only a generated local test password",
  },
  owner.csrf,
);
check(result.status === 200, "owner initiates transfer");
result = await request(base + "/api/auth/transfer-owner", { jar: "member" });
check(
  result.status === 200 && result.data.transfer?.target === member.id,
  "recipient sees pending transfer",
);
result = await post(
  "/api/auth/transfer-owner",
  { action: "accept", currentPassword: "Recovered member local password 123" },
  member.csrf,
  "member",
);
check(
  result.status === 200 && result.data.transferred,
  "recipient accepts ownership",
);
check(
  (await request(base + "/api/auth/session")).status === 401,
  "former owner session revoked",
);
check(
  (await request(base + "/api/auth/session", { jar: "member" })).status === 401,
  "new owner must reauthenticate",
);
writeFileSync(
  process.env.COBUILD_FLOW_RECEIPT,
  JSON.stringify({
    projectId,
    requirementId: requirement,
    pageId: page.id,
    spaceId: project.knowledgeSpace.spaceId,
    organizationId: owner.organizationId,
  }),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    passed: true,
    checks,
    scope: "native identity + directory + Kick/Makit/WeKnow collaboration",
    externalMessages: false,
  }),
);
