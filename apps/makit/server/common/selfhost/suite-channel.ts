// Keep protocol compatible with packages/service/channel.mjs.
import { transportFetch } from './suite-backchannel';
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync, existsSync } from "node:fs";
export function serviceKey(path: string, create = false) {
  if (create && !existsSync(path))
    writeFileSync(path, randomBytes(32).toString("hex") + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o077 || s.size > 256)
    throw Error("Unsafe suite service key");
  const key = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error("Invalid suite service key");
  return key;
}
const signature = (key: string, path: string, body: unknown) =>
  createHmac("sha256", key)
    .update(path + "\n" + JSON.stringify(body))
    .digest("hex");
export function verifyService(
  headers: Record<string, any>,
  body: any,
  path: string,
  keyFile: string,
) {
  const supplied = headers["x-cobuild-signature"];
  if (
    headers.origin ||
    headers["sec-fetch-site"] ||
    !body ||
    Object.keys(body).some((k) => !["at", "nonce", "payload"].includes(k)) ||
    !Number.isSafeInteger(body.at) ||
    Math.abs(Date.now() - body.at) > 60000 ||
    !/^[a-f0-9]{32}$/.test(body.nonce || "") ||
    !body.payload ||
    typeof body.payload !== "object" ||
    Array.isArray(body.payload) ||
    typeof supplied !== "string" ||
    !/^[a-f0-9]{64}$/.test(supplied)
  )
    throw Object.assign(Error("Invalid service request"), { status: 401 });
  const expected = signature(serviceKey(keyFile), path, body);
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
    throw Object.assign(Error("Invalid service signature"), { status: 401 });
  return body.payload;
}
export async function serviceRequest(
  origin: string,
  path: string,
  payload: unknown,
  keyFile: string,
) {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      ))
  )
    throw Error("Explicit service origin required");
  const body = {
    at: Date.now(),
    nonce: randomBytes(16).toString("hex"),
    payload,
  };
  const r = await transportFetch(origin, path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Host": new URL(origin).host,
      "X-CoBuild-Signature": signature(serviceKey(keyFile), path, body),
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of r.body!) {
    if ((size += c.length) > 2 * 1024 * 1024)
      throw Error("Service response too large");
    chunks.push(c);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!r.ok)
    throw Object.assign(Error("Suite connection failed"), {
      status: r.status,
      code: "SUITE_" + r.status,
      permanent: [400, 401, 403, 404, 409, 422].includes(r.status),
    });
  return value;
}
