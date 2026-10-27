// Server-side integration helper. Never bundle this into a browser or MCP model input.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
const ISSUER = "https://internal.110-lab.cn";
const opaque = (v) => typeof v === "string" && /^[\w-]{43}$/.test(v);
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createIdentityClient({
  audience,
  redirectUri,
  fetcher = fetch,
  now = Date.now,
} = {}) {
  if (typeof audience !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(audience))
    throw new Error("Invalid identity audience");
  const callback = new URL(redirectUri);
  if (
    callback.protocol !== "https:" ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    callback.href !== redirectUri
  )
    throw new Error("Expected a canonical HTTPS callback");
  function validateProfile(v) {
    if (
      !v ||
      v.issuer !== ISSUER ||
      v.audience !== audience ||
      typeof v.tenantKey !== "string" ||
      !v.tenantKey ||
      typeof v.unionId !== "string" ||
      !/^on_[\w-]+$/.test(v.unionId) ||
      v.subject !== v.tenantKey + ":" + v.unionId ||
      typeof v.name !== "string" ||
      !Number.isFinite(Date.parse(v.expiresAt)) ||
      Date.parse(v.expiresAt) <= now() ||
      Date.parse(v.expiresAt) > now() + 30 * 86400000
    )
      throw new Error("Invalid identity response");
    return v;
  }
  async function post(action, input) {
    const r = await fetcher(ISSUER + "/api/identity/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok)
      throw Object.assign(new Error("Identity request rejected"), {
        status: r.status,
      });
    // Size-bound responses: do not accept an unbounded body from a proxy error.
    let size = 0,
      parts = [];
    for await (const part of r.body) {
      if ((size += part.length) > 32768)
        throw new Error("Identity response too large");
      parts.push(part);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  }
  return Object.freeze({
    begin() {
      const state = randomBytes(32).toString("base64url"),
        verifier = randomBytes(32).toString("base64url");
      const url = new URL("/auth", ISSUER);
      url.search = new URLSearchParams({
        audience,
        redirect_uri: redirectUri,
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      }).toString();
      return {
        url: url.href,
        flow: { state, verifier, expiresAt: now() + 10 * 60000 },
      };
    },
    async exchange(callbackUrl, flow) {
      const u = new URL(callbackUrl),
        p = u.searchParams;
      if (
        !flow ||
        !opaque(flow.state) ||
        !opaque(flow.verifier) ||
        !Number.isFinite(flow.expiresAt) ||
        flow.expiresAt <= now() ||
        flow.expiresAt > now() + 10 * 60000 ||
        u.origin !== callback.origin ||
        u.pathname !== callback.pathname ||
        u.username ||
        u.password ||
        u.hash ||
        !["state", "code", "iss"].every((k) => p.getAll(k).length === 1) ||
        p.has("error") ||
        p.get("iss") !== ISSUER ||
        !same(p.get("state"), flow.state) ||
        !opaque(p.get("code"))
      )
        throw new Error("Invalid identity callback");
      const v = validateProfile(
        await post("exchange", {
          audience,
          redirectUri,
          state: flow.state,
          verifier: flow.verifier,
          code: p.get("code"),
        }),
      );
      if (!opaque(v.token)) throw new Error("Invalid identity credential");
      return v;
    },
    async inspect(token) {
      if (!opaque(token)) throw new Error("Invalid identity credential");
      return validateProfile(await post("inspect", { audience, token }));
    },
    async navigation(token) {
      if (!opaque(token)) throw new Error("Invalid identity credential");
      return post("navigation", {audience, token});
    },
    async revoke(token) {
      if (!opaque(token)) throw new Error("Invalid identity credential");
      await post("revoke", { audience, token });
    },
  });
}
