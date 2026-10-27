const ORIGIN = "https://cobuild.110-lab.cn";
export function mountRelayWidget({ app, grant }) {
  const host = document.createElement("div");
  host.dataset.relayLauncher = app;
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial;font-family:system-ui,sans-serif}button{box-sizing:border-box;position:fixed;z-index:2147483001;width:52px;height:52px;display:grid;place-items:center;border:1px solid #ffffffb3;border-radius:50%;background:#fff;box-shadow:0 4px 20px #18355b24;cursor:grab;touch-action:none;user-select:none}button:hover{box-shadow:0 5px 24px #18355b38}button:focus-visible{outline:3px solid #6793ff;outline-offset:3px}button:active{cursor:grabbing}svg{width:30px;height:30px;pointer-events:none}section{box-sizing:border-box;position:fixed;z-index:2147483000;border:1px solid #e5e9f0;border-radius:18px;overflow:hidden;box-shadow:0 12px 55px #142f552b;background:white}section[hidden]{display:none}.unread{box-sizing:border-box;position:absolute;right:-5px;top:-5px;min-width:21px;height:21px;padding:0 5px;border:2px solid #fff;border-radius:12px;background:#e33c4b;color:#fff;font-size:11px;font-weight:700;line-height:17px;text-align:center;pointer-events:none}.unread[hidden]{display:none}iframe{width:100%;height:100%;border:0;display:block}@media(prefers-reduced-motion:no-preference){section{animation:appear .18s ease-out}@keyframes appear{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}}`;
  const button = document.createElement("button");
  button.type = "button";
  button.title = "咨询客服";
  button.setAttribute("aria-label", "咨询客服");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-labelledby="title">\n  <title id="title">Relay \u2014 \u5ba2\u670d\u4e0e\u5de5\u5355\u56fe\u6807\u6982\u5ff5</title>\n  <path fill="#BCEEE8" d="M35 10h36c10 0 18 8 18 18v25c0 10-8 18-18 18h-5L51 82V71H35c-10 0-18-8-18-18V28c0-10 8-18 18-18Z"/>\n  <path fill="#119A9A" d="M24 23h36c10 0 18 8 18 18v22c0 10-8 18-18 18H37L16 92V79C10 76 7 70 7 63V41c0-10 7-18 17-18Z"/>\n  <path fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M27 47h32m-9-9 9 9-9 9M27 65h17"/>\n</svg>\n';
  const badge = document.createElement("span");
  badge.className = "unread";
  badge.hidden = true;
  badge.setAttribute("aria-hidden", "true");
  button.append(badge);
  const monitor = document.createElement("iframe");
  monitor.title = "客服未读消息检查";
  monitor.style.display = "none";
  monitor.setAttribute("aria-hidden", "true");
  monitor.tabIndex = -1;
  monitor.src =
    ORIGIN + "/relay/unread.html?app=" + encodeURIComponent(app) + "&bridge=1";
  const panel = document.createElement("section");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "客服");
  root.append(style, button, panel, monitor);
  document.body.append(host);
  let point = { x: innerWidth - 78, y: innerHeight - 96 },
    drag = null,
    suppress = false,
    frame = null,
    open = false,
    destroyed = false,
    count = 0;
  const serials = new Map();
  try {
    const saved = JSON.parse(
      localStorage.getItem("relay-launcher-position:" + app) || "null",
    );
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) point = saved;
  } catch {
    /* Position persistence is optional. */
  }
  const clamp = () => {
    point = {
      x: Math.max(12, Math.min(point.x, innerWidth - 64)),
      y: Math.max(12, Math.min(point.y, innerHeight - 64)),
    };
  };
  function layout() {
    clamp();
    button.style.left = point.x + "px";
    button.style.top = point.y + "px";
    if (innerWidth <= 640) {
      Object.assign(panel.style, {
        left: "8px",
        top: "8px",
        width: Math.max(0, innerWidth - 16) + "px",
        height: Math.max(0, innerHeight - 16) + "px",
      });
    } else {
      Object.assign(panel.style, {
        left:
          Math.max(12, Math.min(point.x + 52 - 390, innerWidth - 402)) + "px",
        top: Math.max(12, Math.min(point.y - 622, innerHeight - 634)) + "px",
        width: "390px",
        height: Math.min(610, innerHeight - 24) + "px",
      });
    }
  }
  function label() {
    button.setAttribute(
      "aria-label",
      (open ? "关闭客服" : "咨询客服") +
        (count ? "，" + count + " 条未读消息" : ""),
    );
    button.title = count ? "客服 · " + count + " 条未读消息" : "咨询客服";
  }
  function visibility() {
    frame?.contentWindow.postMessage(
      {
        type: "RELAY_WIDGET_VISIBILITY",
        app,
        visible: open && document.visibilityState === "visible",
      },
      ORIGIN,
    );
  }
  function setOpen(value) {
    open = value;
    panel.hidden = !value;
    button.setAttribute("aria-expanded", String(value));
    label();
    if (value && !frame) {
      frame = document.createElement("iframe");
      frame.title = "客服";
      frame.src =
        ORIGIN +
        "/relay/?view=widget&app=" +
        encodeURIComponent(app) +
        "&bridge=1";
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
      );
      panel.append(frame);
    }
    if (!value) {
      visibility();
      serials.delete(frame);
      frame?.remove();
      frame = null;
      button.focus();
    }
    visibility();
    layout();
  }
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    suppress = false;
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      point: { ...point },
      moved: false,
    };
    button.setPointerCapture(e.pointerId);
  });
  button.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved) {
      point = { x: drag.point.x + dx, y: drag.point.y + dy };
      layout();
    }
  });
  function endDrag(e) {
    if (!drag || drag.id !== e.pointerId) return;
    suppress = drag.moved;
    if (button.hasPointerCapture(e.pointerId))
      button.releasePointerCapture(e.pointerId);
    drag = null;
    try {
      localStorage.setItem(
        "relay-launcher-position:" + app,
        JSON.stringify(point),
      );
    } catch {
      /* Position persistence is optional. */
    }
  }
  button.addEventListener("pointerup", endDrag);
  button.addEventListener("pointercancel", endDrag);
  button.addEventListener("click", () => {
    if (suppress) {
      suppress = false;
      return;
    }
    setOpen(!open);
  });
  const escape = (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  };
  async function receive(e) {
    if (destroyed || e.origin !== ORIGIN) return;
    const target =
      e.source === monitor.contentWindow
        ? monitor
        : e.source === frame?.contentWindow
          ? frame
          : null;
    if (!target) return;
    if (target === monitor && e.data?.type === "RELAY_UNREAD_COUNT") {
      if (
        e.data.app !== app ||
        !Number.isSafeInteger(e.data.count) ||
        e.data.count < 0
      )
        return;
      count = e.data.count;
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? "99+" : String(count);
      label();
      return;
    }
    if (target === frame) {
      if (e.data?.type === "RELAY_CLOSE") {
        setOpen(false);
        return;
      }
      if (e.data?.type === "RELAY_WIDGET_VISIBILITY_REQUEST") {
        visibility();
        return;
      }
      if (e.data?.type === "RELAY_UNREAD_REFRESH") {
        monitor.contentWindow.postMessage(
          { type: "RELAY_UNREAD_REFRESH", app },
          ORIGIN,
        );
        return;
      }
    }
    if (
      e.data?.type !== "RELAY_WIDGET_READY" ||
      e.data.app !== app ||
      !/^[\w-]{43}$/.test(e.data.challenge || "")
    )
      return;
    const current = (serials.get(target) || 0) + 1;
    serials.set(target, current);
    try {
      const value = await grant(e.data.challenge);
      if (!destroyed && current === serials.get(target)) {
        target.contentWindow.postMessage(
          { type: "RELAY_WIDGET_GRANT", app, grant: value.grant },
          ORIGIN,
        );
        if (target === frame) visibility();
      }
    } catch (error) {
      if (!destroyed && current === serials.get(target)) {
        target.contentWindow.postMessage(
          {
            type: "RELAY_WIDGET_ERROR",
            app,
            message: "暂时无法连接客服，请关闭后重试",
          },
          ORIGIN,
        );
        if (error?.status === 401) destroy();
      }
    }
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    serials.clear();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("message", receive);
    window.removeEventListener("resize", layout);
    window.removeEventListener("keydown", escape);
    host.remove();
  }
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("message", receive);
  window.addEventListener("resize", layout);
  window.addEventListener("keydown", escape);
  layout();
  return { destroy };
}
