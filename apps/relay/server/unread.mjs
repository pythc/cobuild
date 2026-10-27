// Only public, delivered outgoing messages are customer unread replies.
export function publicReply(message) {
  return (
    message.message_type === 1 &&
    message.private === false &&
    message.status !== "failed" &&
    !message.content_attributes?.deleted &&
    ((typeof message.content === "string" && !!message.content.trim()) ||
      message.attachments?.length > 0)
  );
}
export class UnreadReplies {
  constructor(store, chat) {
    this.store = store;
    this.chat = chat;
    this.inflight = new Map();
    this.checked = new Map();
  }
  ingest(row, messages) {
    const valid = messages.filter(
      (m) => Number.isSafeInteger(m.id) && m.id > 0,
    );
    const replies = valid
      .filter(
        (m) =>
          publicReply(m) &&
          Number(m.created_at) * 1000 >= this.store.unreadEpoch(),
      )
      .map((m) => m.id);
    this.store.saveReplies(row.id, 0, replies);
  }
  async sync(row) {
    if (this.inflight.has(row.id)) return this.inflight.get(row.id);
    if ((this.checked.get(row.id) || 0) > Date.now() - 4000) return;
    const work = this.scan(row);
    this.inflight.set(row.id, work);
    try {
      await work;
      if (this.checked.size > 10000) this.checked.clear();
      this.checked.set(row.id, Date.now());
    } finally {
      this.inflight.delete(row.id);
    }
  }
  async scan(row) {
    const cursor = this.store.replyCursor(row.id).scanned_id,
      epoch = this.store.unreadEpoch();
    let before = 0,
      scanned = cursor,
      all = [];
    for (let page = 0; page < 100; page++) {
      const path =
        this.chat.account(`/conversations/${row.remote_id}/messages`) +
        (before ? "?before=" + before : "");
      const v = await this.chat.request(path);
      if (
        !Array.isArray(v.payload) ||
        v.payload.some(
          (m) =>
            !Number.isSafeInteger(m.id) ||
            m.id <= 0 ||
            !Number.isFinite(Number(m.created_at)),
        )
      )
        throw Error("Invalid reply page");
      const messages = v.payload;
      all.push(...messages);
      scanned = Math.max(scanned, ...messages.map((m) => m.id));
      if (
        messages.length < 20 ||
        messages.some(
          (m) => m.id <= cursor || Number(m.created_at) * 1000 < epoch,
        )
      ) {
        this.ingest(row, all);
        this.store.saveReplies(row.id, scanned, []);
        return;
      }
      const next = Math.min(...messages.map((m) => m.id));
      if (before && next >= before)
        throw Error("Reply pagination did not advance");
      before = next;
    }
    // Never advance the cursor or return a false zero after incomplete catch-up.
    throw Error("Reply catch-up incomplete");
  }
}
