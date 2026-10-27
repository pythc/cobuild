import { request, sourceApp } from "./api.js";
// This document does not render chat, create a conversation, or mark messages read.
let running = false,
  again = false,
  revision = 0;
async function refresh() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  const started = revision;
  try {
    const value = await request("/api/relay/unread");
    if (started === revision)
      parent.postMessage(
        { type: "RELAY_UNREAD_COUNT", app: sourceApp, count: value.count },
        "*",
      );
  } catch {
    /* Retain the last confirmed count until connectivity returns. */
  } finally {
    running = false;
    if (again) {
      again = false;
      void refresh();
    }
  }
}
window.addEventListener("message", (event) => {
  if (
    event.source !== parent ||
    ![
      "https://makit.110-lab.cn","https://internal.110-lab.cn",
      "https://knowledge.110-lab.cn",
      "https://exam.110-lab.cn",
      "https://aigrading.110-lab.cn",
      "https://fcncvoyreb8p.feishuapp.com",
    ].includes(event.origin) ||
    event.data?.type !== "RELAY_UNREAD_REFRESH"
  )
    return;
  revision++;
  void refresh();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
window.addEventListener("online", () => void refresh());
setInterval(() => void refresh(), 5000);
void refresh();
