import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serviceRequest } from "../packages/service/channel.mjs";
const cfg = JSON.parse(readFileSync(process.env.COBUILD_CONFIG)),
  saved = JSON.parse(readFileSync(process.env.COBUILD_FLOW_RECEIPT)),
  cookies = new Map();
let checks = 0;
async function req(url, body, headers = {}) {
  const origin = new URL(url).origin,
    jar = cookies.get(origin) || new Map();
  const r = await fetch(url, {
    method: body ? "POST" : "GET",
    redirect: "manual",
    headers: {
      ...(jar.size
        ? { Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") }
        : {}),
      ...(body ? { "Content-Type": "application/json", Origin: origin } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  for (const value of r.headers.getSetCookie()) {
    const first = value.split(";")[0],
      i = first.indexOf("=");
    jar.set(first.slice(0, i), first.slice(i + 1));
  }
  cookies.set(origin, jar);
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, headers: r.headers, data: data?.data || data };
}
function check(value, label) {
  assert.ok(value, label);
  checks++;
}
const base = cfg.origins.platform;
let r = await req(base + "/api/auth/login", {
  email: "member@example.test",
  password: "Recovered member local password 123",
});
check(
  r.status === 200 && r.data.role === "super_admin",
  "ownership and recovered password persist across service restart",
);
const owner = r.data;
for (const app of ["makit", "weknow"]) {
  r = await req(
    cfg.origins[app] +
      (app === "makit" ? "/auth/start" : "/api/auth/identity/login"),
  );
  const u = new URL(r.headers.get("location"));
  r = await req(
    base + "/api/identity/authorize",
    {
      audience: app === "makit" ? "requirements" : "knowledge",
      redirectUri: u.searchParams.get("redirect_uri"),
      state: u.searchParams.get("state"),
      challenge: u.searchParams.get("code_challenge"),
    },
    { "X-CSRF-Token": owner.csrf },
  );
  r = await req(r.data.redirectUrl);
  check(
    [302, 303].includes(r.status),
    "application SSO survives restart " + app,
  );
}
r = await req(base + "/api/workspace/projects/" + saved.projectId);
check(
  r.status === 200 && r.data.knowledgeSpace.spaceId === saved.spaceId,
  "project and knowledge receipt persisted",
);
r = await req(
  cfg.origins.makit + "/api/workspace/requirements/" + saved.requirementId,
);
check(
  r.status === 200 &&
    r.data.requirement.latestProgress === "Implementation verified locally",
  "requirement update persisted across restart",
);
check(
  r.data.comments.some((c) => c.content === "Ready for review"),
  "comment persisted",
);
check(
  r.data.acceptanceItems.some(
    (a) => a.title === "Core flow works" && a.completed,
  ),
  "acceptance check persisted",
);
r = await req(cfg.origins.weknow + "/api/pages/info", { pageId: saved.pageId });
check(
  r.status === 200 && r.data.title === "Project design",
  "project document persisted",
);
const receipt = await serviceRequest(
  cfg.origins.weknow,
  "/api/suite/projects/ensure",
  { organizationId: saved.organizationId, projectId: saved.projectId },
  join(process.env.COBUILD_DATA_DIR, "weknow.service.key"),
);
check(
  (receipt.data || receipt).spaceId === saved.spaceId,
  "restart retry cannot create a second knowledge space",
);
r = await req(cfg.origins.makit + "/api/selfhost/session");
check(
  !r.data.roles.includes("admin"),
  "new organization owner does not inherit Makit administrator role",
);
r = await req(cfg.origins.weknow + "/api/users/me", {});
check(
  r.data.user.role !== "owner",
  "new organization owner does not inherit WeKnow owner role",
);
r = await req(
  base + "/api/auth/change-password",
  {
    currentPassword: "Recovered member local password 123",
    password: "Changed after restart local password 123",
  },
  { "X-CSRF-Token": owner.csrf },
);
check(r.status === 200, "owner changes password through native HTTP");
check(
  (await req(cfg.origins.makit + "/api/selfhost/session")).status === 401,
  "password change invalidates Makit session",
);
check(
  (await req(cfg.origins.weknow + "/api/users/me", {})).status === 401,
  "password change invalidates WeKnow session",
);
console.log(
  JSON.stringify({
    passed: true,
    checks,
    scope: "three-service restart and account password revocation",
  }),
);
