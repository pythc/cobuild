import { managedCollaboration } from './managed-collaboration.mjs';
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
      ...(body ? { ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }), Origin: origin } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
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
// Contract-backed rename traverses the existing durable snapshot consumer.
const renameInput={requestId:randomUUID(),revision:project.revision,name:'Renamed portable project'};
result=await post('/api/workspace/projects/'+projectId+'/rename',renameInput,member.csrf,'member');
check(result.status===403,'project member cannot invoke rename command');
result=await post('/api/workspace/projects/'+projectId+'/rename',renameInput,owner.csrf);
check(result.status===200 && result.data.operation.resource.id===projectId,'rename commits stable resource and operation');
const renameOperationId=result.data.operation.id;
result=await post('/api/workspace/projects/'+projectId+'/rename',renameInput,owner.csrf);
check(result.status===200 && result.data.operation.id===renameOperationId && result.data.operation.replayed,'HTTP rename replay retains operation');
result=await post('/api/workspace/projects/'+projectId+'/rename',{...renameInput,name:'Conflicting reuse'},owner.csrf);
check(result.status===409 && result.data.code==='REQUEST_CONFLICT','changed request key is rejected');
project=await pollProject(projectId,p=>p.name===renameInput.name && p.requirementsSync.state==='synced'&&p.knowledgeSpace.state==='ready');
result=await request(base+'/api/workspace/projects/operations/'+renameOperationId);
check(result.status===200 && result.data.state==='succeeded' && result.data.deliveries[0].receipt.mode==='snapshot-converged','remote acknowledgement settles durable operation');
result=await request(base+'/api/workspace/projects/operations/'+renameOperationId,{jar:'member'});
check(result.status===403,'operation detail uses current project authority');
result=await request(config.origins.makit+'/api/workspace/project-management');
projected=(result.data?.data||result.data)?.projects?.find(p=>p.projectId===projectId);
check(projected?.projectName===renameInput.name,'Makit projects the new name under the same UUID');
const originalSpaceId=project.knowledgeSpace.spaceId;
result=await request(config.origins.weknow+'/api/spaces/info',{body:{spaceId:originalSpaceId}});
check((result.data?.data||result.data)?.name===renameInput.name,'WeKnow renames the existing managed space');
result=await request(config.origins.weknow+'/api/spaces/update',{body:{spaceId:originalSpaceId,name:'Manual independent name'}});
check(result.status===200,'native independent space rename');
project=(await request(base+'/api/workspace/projects/'+projectId)).data;
result=await post('/api/workspace/projects/'+projectId+'/rename',{requestId:randomUUID(),revision:project.revision,name:'Final portable project'},owner.csrf);
check(result.status===200,'new project rename with independently changed space');
project=await pollProject(projectId,p=>p.knowledgeSpace.state==='blocked');
check(project.knowledgeSpace.errorCode==='KNOWLEDGE_NAME_CONFLICT','manual WeKnow name produces actionable conflict');
result=await request(config.origins.weknow+'/api/spaces/info',{body:{spaceId:originalSpaceId}});
check((result.data?.data||result.data)?.name==='Manual independent name','independent name is not overwritten');
await request(config.origins.weknow+'/api/spaces/update',{body:{spaceId:originalSpaceId,name:project.name}});
result=await post('/api/workspace/projects/'+projectId+'/knowledge-space/retry',{},owner.csrf);
check(result.status===200,'owner retries resolved name conflict');
project=await pollProject(projectId,p=>p.knowledgeSpace.state==='ready'&&p.requirementsSync.state==='synced');
check(project.knowledgeSpace.spaceId===originalSpaceId,'rename conflict recovery retains stable space ID');

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
    project: project.name,
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
// Backported review controls run through native identity and the application database.
const engineeringUrl = config.origins.makit + '/api/workspace/requirements/' + requirement;
result = await request(engineeringUrl + '/engineering', { jar: 'member' });
check(result.status === 200, 'native member reads the retained engineering workspace');
check(unwrap(result).history.length === 0, 'disabled AI leaves new requirement review history empty');
result = await request(engineeringUrl + '/release-readiness', { jar: 'member' });
check(result.status === 200, 'release readiness remains readable with AI disabled');
check(unwrap(result).checks.find(x => x.key === 'self_test_report')?.passed === false, 'missing report still blocks its release check');
const savedReport = 'Verified native identity, project assignment, permission revocation and retry paths.';
result = await request(engineeringUrl + '/artifacts/self_test_report', { jar: 'member', method: 'PATCH', body: { sourceType: 'inline', content: savedReport } });
check(result.status === 200, 'native member saves a self-test artifact with AI disabled');
check(unwrap(result).artifacts.self_test_report?.content === savedReport, 'existing workspace displays the saved artifact');
check(unwrap(result).history.length === 0, 'saving an artifact does not enqueue AI');
result = await request(engineeringUrl + '/release-readiness', { jar: 'member' });
check(result.status === 200 && unwrap(result).checks.find(x => x.key === 'self_test_report')?.passed === true, 'release gate reads the same saved artifact');
result = await request(engineeringUrl + '/reviews/clarity/retry', { jar: 'member', body: {} });
check(result.status === 503 && JSON.stringify(result.data).includes('AI 评审已停用'), 'native HTTP retry reports AI disabled');
result = await request(engineeringUrl + '/engineering', { jar: 'member' });
check(result.status === 200 && unwrap(result).history.length === 0, 'retry preserves artifacts and review history');
result = await request(engineeringUrl + '/engineering', { jar: 'anonymous-review' });
check(result.status === 401, 'engineering data still requires login');
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
project=(await request(base+'/api/workspace/projects/'+projectId)).data;
const receipts = await Promise.all(
  [1, 2].map(() =>
    serviceRequest(
      config.origins.weknow,
      "/api/suite/projects/ensure",
      { organizationId: owner.organizationId, projectId,revision:project.revision,name:project.name,expectedName:project.name,archived:project.archived },
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
// Managed scope is enforced below native roles, before pagination and on file URLs.
const wk = (path, body, jar='member') => request(config.origins.weknow + path, {body,jar});
const spaceId=project.knowledgeSpace.spaceId;
const wkMember=(weknowMember.data || weknowMember).user.id;
result=await wk('/api/spaces/members',{spaceId,limit:100},'owner');
const initialMembers=(result.data.data||result.data).items;
check(result.status===200 && Array.isArray(initialMembers) && initialMembers.length>0 && initialMembers.every(m=>m.type==='user'),'new managed space never grants Everyone');
result=await wk('/api/spaces/create',{name:'Legacy shared fixture',slug:'legacy-shared-fixture'},'owner');
const shared=(result.data.data||result.data).id;
check(result.status===200 && shared,'ordinary space preserves shared policy');
const form=new FormData();form.append('pageId',page.id);form.append('file',new Blob(['managed access proof'],{type:'text/plain'}),'managed-proof.txt');
result=await wk('/api/files/upload',form);
check(result.status===200 && (result.data.data||result.data).id,'member uploads managed attachment');
const filePath='/api/files/'+(result.data.data||result.data).id+'/managed-proof.txt';
check((await wk(filePath)).status===200,'member reads managed attachment');
result=await wk('/api/spaces/members/change-role',{spaceId,userId:wkMember,role:'reader'},'owner');
check(result.status===200,'owner narrows native role');
check((await wk('/api/pages/create',{spaceId,title:'Should not write'})).status===403,'project qualification cannot bypass native read-only ACL');
check((await wk('/api/pages/info',{pageId:page.id})).status===200,'native reader retains managed read');
result=await wk('/api/spaces/members/change-role',{spaceId,userId:wkMember,role:'writer'},'owner');
check(result.status===200,'owner restores writer');
result=await wk('/api/spaces/members/remove',{spaceId,userId:wkMember},'owner');
check(result.status===200,'owner removes native space membership');
for(let attempt=0;attempt<2;attempt++)check([403,404].includes((await wk('/api/pages/info',{pageId:page.id})).status),'active project qualification does not restore a removed native role');
result=await wk('/api/spaces/members/add',{spaceId,userIds:[wkMember],groupIds:[],role:'writer'},'owner');
check(result.status===200,'native role restored explicitly');
result=await wk('/api/spaces/members',{spaceId:shared,limit:100},'owner');
const everyone=(result.data.data||result.data).items?.find(m=>m.type==='group' && m.isDefault);
check(result.status===200 && everyone,'ordinary shared space retains Everyone');
result=await wk('/api/spaces/members/add',{spaceId,userIds:[],groupIds:[everyone.id],role:'reader'},'owner');
check(result.status===200,'native group grant added for eligibility intersection test');
async function setMembers(members) {
  const p=(await request(base+'/api/workspace/projects/'+projectId)).data;
  const r=await post('/api/workspace/projects/'+projectId+'/update',{requestId:randomUUID(),revision:p.revision,name:p.name,summary:p.summary,members,links:p.links},owner.csrf);
  check(r.status===200,'project membership change commits '+r.status+' '+JSON.stringify(r.data));
}
// A separate OAuth grant must obey live membership even with a valid read scope.
const wkOrigin=config.origins.weknow,callback='http://127.0.0.1:49151/callback';
result=await wk('/api/knowledge/oauth/register',{client_name:'Managed access fixture',redirect_uris:[callback],token_endpoint_auth_method:'none',scope:'knowledge:read'});
check([200,201].includes(result.status),'register isolated knowledge OAuth client');
const clientId=result.data.client_id,knowledgeVerifier=randomBytes(32).toString('base64url');
const authQuery=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:callback,resource:wkOrigin+'/mcp',scope:'knowledge:read',code_challenge:createHash('sha256').update(knowledgeVerifier).digest('base64url'),code_challenge_method:'S256'});
result=await wk('/api/knowledge/oauth/authorize?'+authQuery);
check(result.status===302,'knowledge OAuth authorization request');
const authorizationId=new URL(result.headers.get('location')).searchParams.get('request');
result=await wk('/api/knowledge/oauth/requests/'+authorizationId+'/resolve',{approve:true,scopes:['knowledge:read']});
check(result.status===200,'synthetic member authorizes knowledge read');
const authResult=result.data.data||result.data;
result=await wk('/api/knowledge/oauth/token',{grant_type:'authorization_code',client_id:clientId,code:new URL(authResult.redirectUrl).searchParams.get('code'),redirect_uri:callback,resource:wkOrigin+'/mcp',code_verifier:knowledgeVerifier});
check(result.status===200 && result.data.access_token,'knowledge token issued');
const knowledgeToken=result.data.access_token;
const kbRead=()=>request(wkOrigin+'/mcp',{jar:'oauth-client',body:{jsonrpc:'2.0',id:21,method:'tools/call',params:{name:'kb_document_get',arguments:{pageId:page.id}}},headers:{Authorization:'Bearer '+knowledgeToken,Accept:'application/json, text/event-stream'}});
result=await kbRead();
check(result.status===200 && result.data.result && !result.data.result.isError,'MCP reads allowed managed document '+result.status);
result=await wk('/api/auth/collab-token',{});
check(result.status===200,'managed member gets collaboration token');
const collabToken=(result.data.data||result.data).token;
const liveCollaboration=await managedCollaboration(wkOrigin,page.id,collabToken);
check(true,'real managed document WebSocket authenticates');
await setMembers([]);
await liveCollaboration.revoked();
check(true,'existing collaboration connection rejects revoked writes and closes');
result=await kbRead();
check(result.status===200 && (result.data.result?.isError || result.data.error) || [403,404].includes(result.status),'existing MCP OAuth grant cannot bypass member removal');
check([403,404].includes((await wk('/api/pages/info',{pageId:page.id})).status),'revoked member denied direct native page');
check([403,404].includes((await wk(filePath)).status),'revoked member denied previously downloaded file URL');
check([403,404].includes((await wk('/api/pages/create',{spaceId,title:'Denied'})).status),'revoked member denied write despite native grant');
result=await wk('/api/spaces',{limit:100});
check(result.status===200 && !JSON.stringify(result.data).includes(spaceId),'revoked space omitted before list pagination');
result=await wk('/api/search',{query:'Project design'});
check(result.status===200 && !JSON.stringify(result.data).includes(page.id),'search results do not leak revoked page');
check((await wk('/api/spaces/info',{spaceId:shared})).status===200,'legacy shared access survives project removal');
await post('/api/organization/users/'+member.id,{role:'admin'},owner.csrf);
check([403,404].includes((await wk('/api/pages/info',{pageId:page.id})).status),'organization administrator cannot bypass project scope');
await post('/api/organization/users/'+member.id,{role:'member'},owner.csrf);
await setMembers(projectInput.members);
check((await wk('/api/pages/info',{pageId:page.id})).status===200,'rejoining project restores qualified access');
result=await wk('/api/shares/create',{pageId:page.id},'owner');
check([403,404].includes(result.status),'managed page cannot be published by native space administrator '+result.status+' '+JSON.stringify(result.data));
for(const archived of [true,false]) {
  const p=(await request(base+'/api/workspace/projects/'+projectId)).data;
  result=await post('/api/workspace/projects/'+projectId+'/archive',{revision:p.revision,archived},owner.csrf);
  check(result.status===200,'project archive state changes');
  result=await wk('/api/pages/info',{pageId:page.id});
  check(archived?[403,404].includes(result.status):result.status===200,'managed access follows current project archive state');
  const converged=await pollProject(projectId,p=>p.requirementsSync.state==='synced'&&p.knowledgeSpace.state===(archived?'archived':'ready'));
  check(converged.knowledgeSpace.spaceId===spaceId,'archive/restore preserves managed space');
  result=await request(config.origins.makit+'/api/workspace/requirements',{body:{title:'Archive policy fixture',project:converged.name,type:'产品需求',introduction:'Local fixture',acceptanceCriteria:'No external delivery',handlerLarkUserIds:[member.id]}});
  check(archived?result.status===409:[200,201].includes(result.status),'Makit requirement creation follows live project archive state '+result.status);
  if(archived){
    result=await request(config.origins.makit+'/api/workspace/requirements',{body:{title:'Alias bypass fixture',project:renameInput.name,type:'产品需求',introduction:'Local fixture',acceptanceCriteria:'No external delivery',handlerLarkUserIds:[member.id]}});
    check([400,409].includes(result.status),'historical project name cannot bypass archive '+result.status);
    const aliasPolicy=await serviceRequest(base,'/api/suite/services/makit/project-writes',{organizationId:owner.organizationId,names:[renameInput.name]},join(process.env.COBUILD_DATA_DIR,'makit.service.key'));
    check(aliasPolicy.blockedNames.includes(renameInput.name),'write policy recognizes historical name independently of UI options');
    const beforeArchivedWrite=unwrap(await request(config.origins.makit+'/api/workspace/requirements/'+requirement,{jar:'member'}));
    result=await request(config.origins.makit+'/api/workspace/requirements/'+requirement,{jar:'member',method:'PATCH',body:{clientMutationId:randomUUID(),expectedUpdatedAt:beforeArchivedWrite.requirement.updatedAt,patch:{latestProgress:'Must not persist while archived'}}});
    const archivedJob=unwrap(result).jobId;
    check(!!archivedJob,'queued update retains durable job '+result.status+' '+JSON.stringify(result.data));
    for(let i=0;i<100;i++){
      result=await request(config.origins.makit+'/api/workspace/requirement-update-jobs/'+archivedJob,{jar:'member'});
      if(['succeeded','failed','unknown'].includes(unwrap(result)?.status))break;
      await new Promise(r=>setTimeout(r,200));
    }
    check(unwrap(result)?.status==='failed','background writer rejects archived project');
    result=await request(config.origins.makit+'/api/workspace/requirements/'+requirement,{jar:'member'});
    check(unwrap(result).requirement.latestProgress!=='Must not persist while archived','rejected worker leaves prior content intact');
    result=await request(config.origins.makit+'/api/workspace/requirements/'+requirement+'/comments',{jar:'member',body:{content:'Blocked archived comment'}});
    check(result.status===409,'archived project blocks linked comments');
    result=await request(config.origins.makit+'/api/workspace/requirements/'+requirement+'/acceptance',{body:{title:'Blocked acceptance',ownerUserIds:[],note:''}});
    check(result.status===409,'archived project blocks linked acceptance items '+result.status);
  }

}

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
    renameOperationId,
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
