import {consultationCard} from "./notification-cards.mjs";
export class NoticeWorker {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.token = "";
    this.expires = 0;
    this.busy = false;
  }
  async request(path, body, token, method = "POST") {
    const r = await fetch("https://open.feishu.cn/open-apis" + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
    let n = 0,
      parts = [];
    for await (const p of r.body) {
      if ((n += p.length) > 262144) throw Error("Invalid bot response");
      parts.push(p);
    }
    const v = JSON.parse(Buffer.concat(parts));
    if (!r.ok || v.code !== 0)
      throw Object.assign(Error("Feishu rejected"), {
        rejected: r.status < 500 && Number.isInteger(v.code) && v.code !== 0,
        code: v.code,
      });
    return v;
  }
  async auth() {
    if (this.expires > Date.now()) return;
    const v = await this.request("/auth/v3/tenant_access_token/internal", {
      app_id: this.config.feishu.appId,
      app_secret: this.config.feishu.appSecret,
    });
    if (!v.tenant_access_token || !v.expire)
      throw Error("Bot authentication failed");
    this.token = v.tenant_access_token;
    this.expires = Date.now() + (v.expire - 120) * 1000;
  }
  async once() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.auth();
      const item = await this.store.nextNotice();
      if (!item) return;
      const payload = this.store.freezeNotice(item,{
        receive_id: this.config.chatId,
        msg_type: "interactive",
        content: JSON.stringify(consultationCard(this.config, item, this.store.attention.summary(item.conversationId))),
        uuid: item.id.slice(0,32),
      });
      let outcome = "unknown",
        messageId;
      try {
        const v = await this.request(
          "/im/v1/messages?receive_id_type=chat_id",
          payload,
          this.token,
        );
        messageId = v.data?.message_id;
        if (typeof messageId === "string" && /^om_[\w-]+$/.test(messageId))
          outcome = "sent";
      } catch (e) {
        if (e.rejected) outcome = "rejected";
        if (e.code === 99991663 || e.code === 99991668) this.expires = 0;
      }
      const receipt = await this.store.noticeResult(
        item.id,
        item.lease,
        outcome,
        messageId,
      );
      console.log(
        JSON.stringify({
          event: "relay_notification",
          outcome,
          accepted: receipt.accepted,
          messageId,
        }),
      );
    } finally {
      this.busy = false;
    }
  }
  start() {
    const tick = () => {
      if (this.busy) return;
      this.active = this.once().catch(() =>
        console.error("Relay notification retry pending"),
      );
    };
    this.timer = setInterval(tick, 5000);
    this.timer.unref();
    void tick();
  }
  async stop() {
    clearInterval(this.timer);
    await this.active;
  }
}
