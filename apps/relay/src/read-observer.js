// Read only a public reply that actually entered the visible chat viewport.
export function observeReadReplies({ root, ids, ack, embedded = false, app }) {
  let hostVisible = !embedded,
    disposed = false,
    busy = false,
    read = 0,
    timer;
  const visible = new Set(),
    wanted = new Set(ids);
  function canRead() {
    return !disposed && hostVisible && document.visibilityState === "visible";
  }
  function schedule() {
    clearTimeout(timer);
    if (canRead() && visible.size) timer = setTimeout(flush, 350);
  }
  async function flush() {
    if (!canRead() || busy) return;
    const next = Math.max(0, ...visible);
    if (next <= read) return;
    busy = true;
    try {
      await ack(String(next));
      read = Math.max(read, next);
    } catch {
      /* Retry only while still visible; the service owns the read cursor. */
    } finally {
      busy = false;
      if (canRead() && Math.max(0, ...visible) > read)
        timer = setTimeout(flush, 2000);
    }
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = Number(e.target.dataset.replyId);
        if (
          e.isIntersecting &&
          e.intersectionRect.height >=
            Math.min(48, e.boundingClientRect.height / 2)
        )
          visible.add(id);
        else visible.delete(id);
      }
      schedule();
    },
    { root, threshold: [0, 0.1, 0.5, 1] },
  );
  for (const target of root.querySelectorAll("[data-reply-id]"))
    if (wanted.has(target.dataset.replyId)) observer.observe(target);
  function receive(e) {
    if (
      e.source !== parent ||
      ![
        "https://makit.110-lab.cn","https://internal.110-lab.cn",
        "https://knowledge.110-lab.cn",
        "https://exam.110-lab.cn",
        "https://aigrading.110-lab.cn",
        "https://fcncvoyreb8p.feishuapp.com",
      ].includes(e.origin) ||
      e.data?.type !== "RELAY_WIDGET_VISIBILITY" ||
      e.data.app !== app
    )
      return;
    hostVisible = e.data.visible === true;
    schedule();
  }
  window.addEventListener("message", receive);
  document.addEventListener("visibilitychange", schedule);
  if (embedded)
    parent.postMessage({ type: "RELAY_WIDGET_VISIBILITY_REQUEST", app }, "*");
  return () => {
    disposed = true;
    clearTimeout(timer);
    observer.disconnect();
    window.removeEventListener("message", receive);
    document.removeEventListener("visibilitychange", schedule);
  };
}
