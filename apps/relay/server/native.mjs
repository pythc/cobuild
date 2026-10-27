import { createHash } from "node:crypto";
const hash = (v) => createHash("sha256").update(v).digest("hex");
export class NativeMakit {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.failedUntil = 0;
    this.cache = new Map();
    this.inflight = new Map();
  }
  async call(action, input, actor) {
    const read = ["lookup", "members"].includes(action);
    if (read && Date.now() < this.failedUntil)
      throw Object.assign(Error("Makit 暂不可用，咨询仍可继续"), {
        status: 503,
      });
    let r;
    try {
      r = await fetch(this.config.makit.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(25000),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.config.makit.openApiKey,
          "X-Relay-Native-Key": this.config.makit.serviceKey,
        },
        body: JSON.stringify({ action, input, token: actor.relayToken }),
      });
    } catch {
      if (read) this.failedUntil = Date.now() + 15000;
      throw Object.assign(Error("Makit 操作结果未确认，请查询原咨询关联"), {
        status: 503,
      });
    }
    let n = 0,
      parts = [];
    for await (const p of r.body) {
      if ((n += p.length) > 4000000) throw Error("Makit response too large");
      parts.push(p);
    }
    let v;
    try {
      v = JSON.parse(Buffer.concat(parts));
    } catch {
      throw Error("Makit response unavailable");
    }
    if (!r.ok) {
      if (r.status >= 500 && read) this.failedUntil = Date.now() + 15000;
      throw Object.assign(Error(v.message || "Makit 暂时无法完成操作"), {
        status: r.status,
      });
    }
    this.failedUntil = 0;
    return v.data ?? v;
  }
  async members(a) {
    return this.call("members", {}, a);
  }
  async create(input, a) {
    let intent = await this.store.read("", input.conversationId);
    if (!intent) {
      intent = {
        conversation_id: input.conversationId,
        marker:
          "relay_v1:" +
          hash(JSON.stringify([this.config.sourceId, input.conversationId])),
        payload_json: JSON.stringify(input),
        state: "preparing",
        created_at: new Date().toISOString(),
      };
      this.store.saveIntent(intent);
    }
    if (intent.requirement_id) return this.get(input.conversationId, a);
    // Native create itself is durably idempotent by source + conversation. Its
    // confirmed receipt repairs this local intent after any interrupted response.
    const result = await this.call(
      "create",
      JSON.parse(intent.payload_json),
      a,
    );
    if (
      result.state !== "linked" ||
      !result.requirement?.id ||
      result.conversationId !== input.conversationId
    )
      throw Error("Makit 关联回执无效");
    intent.requirement_id = result.requirement.id;
    intent.state = "linked";
    this.store.saveIntent(intent);
    this.cache.delete(a.employeeId + ":" + input.conversationId);
    return result;
  }
  async get(id, a, background = false) {
    const k = a.employeeId + ":" + id,
      c = this.cache.get(k);
    if (c && c.expires > Date.now()) return c.value;
    let pending = this.inflight.get(k);
    if (!pending && Date.now() >= this.failedUntil) {
      pending = this.readSnapshot(id, a).finally(() => this.inflight.delete(k));
      this.inflight.set(k, pending);
      pending.catch(() => {}); // The state endpoint retains the durable native ID on failure.
    }
    if (background || !pending)
      throw Object.assign(Error("工单状态同步中，咨询仍可继续"), {
        status: 503,
      });
    return pending;
  }
  async readSnapshot(id, a) {
    const k = a.employeeId + ":" + id;
    const result = await this.call("lookup", { conversationId: id }, a);
    if (result.state !== "linked" || !result.requirement?.id)
      throw Error("Makit 工单暂不可用");
    const local = await this.store.read("", id);
    if (local && !local.requirement_id) {
      local.requirement_id = result.requirement.id;
      local.state = "linked";
      this.store.saveIntent(local);
    }
    this.cache.set(k, { value: result, expires: Date.now() + 10000 });
    if (this.cache.size > 1000) this.cache.clear();
    return result;
  }
  async group(id, a) {
    const result = await this.call("group", { conversationId: id }, a);
    this.cache.clear();
    return result;
  }
  async update(id, input, a) {
    const row = this.store.intentByRequirement(id);
    if (!row) throw Object.assign(Error("工单不存在"), { status: 404 });
    const intent = JSON.parse(row.document);
    const result = await this.call(
      "update",
      { conversationId: intent.conversation_id, ...input },
      a,
    );
    this.cache.clear();
    return result;
  }
  async byRequirement(id, a) {
    const row = this.store.intentByRequirement(id);
    if (!row) throw Object.assign(Error("工单不存在"), { status: 404 });
    return (await this.get(JSON.parse(row.document).conversation_id, a))
      .requirement;
  }
  async context(marker, a) {
    const row = this.store.db
      .prepare("SELECT document FROM intents WHERE marker=?")
      .get(marker);
    if (!row) throw Object.assign(Error("上下文不存在"), { status: 404 });
    const v = JSON.parse(row.document);
    await this.get(v.conversation_id, a);
    return JSON.parse(v.payload_json);
  }
}
