// An open chat window is provisional. Only a delivered public incoming message
// (including an attachment) starts an inquiry and queues its single notification.
export async function activateFromMessages(
  store,
  row,
  messages,
  notify = true,
) {
  const first = messages.find(
    (m) =>
      (m.message_type === 0 || m.message_type === "incoming") &&
      !m.private &&
      ((typeof m.content === "string" && m.content.trim()) ||
        m.attachments?.length) &&
      Number.isSafeInteger(m.id) &&
      m.id > 0,
  );
  if (!first || !notify) await store.suppressEmptyNotice(row.id);
  if (!first) return false;
  const timestamp = Number(first.created_at) * 1000;
  await store.activate(
    row.id,
    first.id,
    Number.isFinite(timestamp) && timestamp > 0 ? timestamp : row.created_at,
    notify,
  );
  return true;
}

// Repairs the small crash window between Chatwoot accepting a message and the
// local activation transaction. Reads only; never resends an uncertain message.
export class ConsultationWorker {
  constructor(chat, store) {
    this.chat = chat;
    this.store = store;
    this.busy = false;
  }
  async once() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const row of await this.store.pendingConsultations()) {
        if (this.stopping) break;
        try {
          if (!this.chat.config().apps[row.app]) continue;
          const remote = await this.chat.request(
            this.chat.account(`/conversations/${row.remote_id}`),
          );
          if (remote.inbox_id !== this.chat.config().apps[row.app].inboxId)
            continue;
          await activateFromMessages(
            this.store,
            row,
            await this.chat.messages(row.remote_id),
            remote.status !== "resolved",
          );
        } catch {
          console.error("Relay consultation reconciliation pending");
        }
      }
    } finally {
      this.busy = false;
    }
  }
  start() {
    this.stopping = false;
    const tick = () => {
      if (!this.busy)
        this.active = this.once().catch(() =>
          console.error("Relay consultation reconciliation pending"),
        );
    };
    this.timer = setInterval(tick, 5000);
    this.timer.unref();
    tick();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.active;
  }
}
