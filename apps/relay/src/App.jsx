import {mergeOutbox, pruneOutbox, deliveryText} from "./outbox.js";
import { createContentMotion } from "./cobuild-motion/content-motion.mjs";
import { connectionFailure } from "./connection-error.js";
import { observeReadReplies } from "./read-observer.js";
import { CoBuildBrand } from "./CoBuildBrand.jsx";
import React, { useState, useEffect, useRef } from "react";
import { APPS, STATUS, PRIORITY, visibleMessages } from "./metadata.js";
import {
  conversationBucket,
  filterConversations,
  selectedConversation,
  messageSender,
} from "./consultation-views.js";
import { launcherPosition, panelPosition } from "./launcher.js";
import {
  request,
  sourceApp,
  bridgedWidget,
  assetBlob,
  mutation,
  connect,
  login,
  state as readState,
} from "./api.js";
const timeText = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Shanghai",
      }).format(date);
};
const query = new URLSearchParams(location.search);
const view = ["customer", "operator", "embed", "widget"].includes(
  query.get("view"),
)
  ? query.get("view")
  : "operator";
const Icon = ({ name, size = 18 }) => (
  <img
    className="icon"
    src={"/relay/assets/icons/" + name + ".svg"}
    width={size}
    height={size}
    alt=""
  />
);
const Mark = ({ app, size = 24 }) => (
  <img
    className={"app-mark " + (app === "cobuild" ? "wide-mark" : "")}
    src={"/relay/assets/" + APPS[app].icon}
    width={size}
    height={size}
    alt={APPS[app].name}
  />
);
const Avatar = ({ small = false }) => (
  <span className={"avatar " + (small ? "small" : "")}>
    <Icon name="user" size={small ? 15 : 19} />
  </span>
);
function Select({ label, value, options, onChange }) {
  const [open, setOpen] = useState(false),
    ref = useRef();
  useEffect(() => {
    function outside(e) {
      if (!ref.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return (
    <div
      className="select"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          ref.current.querySelector(".select-trigger")?.focus();
        }
      }}
    >
      <button
        type="button"
        className="select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {options.find((o) => o.value === value)?.label}
        <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div className="select-options" role="listbox" aria-label={label}>
          {options.map((o) => (
            <button
              type="button"
              role="option"
              aria-selected={value === o.value}
              key={o.value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
              {value === o.value && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function MobileDialog({ className, title, onClose, children }) {
  const ref = useRef();
  useEffect(() => { ref.current.showModal(); }, []);
  return (
    <dialog ref={ref} className={className} aria-label={title}
      onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      {children}
    </dialog>
  );
}
function useViewportHeight() {
  const [height, setHeight] = useState(() => window.visualViewport?.height || window.innerHeight);
  useEffect(() => {
    const resize = () => setHeight(window.visualViewport?.height || window.innerHeight);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, []);
  return height;
}
function Sidebar({ operator, collapsed, onCollapse, profile, connected, requiresLogin, mobile = false }) {
  const [navigation,setNavigation]=useState(null),[navigationError,setNavigationError]=useState(false);
  useEffect(()=>{
    let disposed=false,busy=false;
    setNavigation(null);setNavigationError(false);
    if(!profile?.id || requiresLogin)return;
    async function load(){
      if(busy)return;busy=true;
      try{const value=await request('/api/relay/navigation',{signal:AbortSignal.timeout(12000)});if(!disposed){setNavigation(value);setNavigationError(false);}}
      catch{if(!disposed)setNavigationError(true);}
      finally{busy=false;}
    }
    void load();const timer=setInterval(load,30000);window.addEventListener('focus',load);
    return ()=>{disposed=true;clearInterval(timer);window.removeEventListener('focus',load);};
  },[profile?.id,requiresLogin]);
  return (
    <aside
      className={"sidebar " + (collapsed ? "collapsed" : "")}
      aria-label="CoBuild 主导航"
    >
      <div className="brand">
        {!collapsed && (
          <div className="suite-brand">
            <CoBuildBrand>
              <span className="relay-identity">
                <img
                  src="/relay/assets/relay.svg"
                  width="26"
                  height="26"
                  alt=""
                />
                <strong>Relay</strong>
              </span>
            </CoBuildBrand>
          </div>
        )}
        <button
          className="icon-button"
          aria-label={mobile ? "关闭导航" : collapsed ? "展开侧栏" : "收起侧栏"}
          onClick={onCollapse}
        >
          <Icon
            name={
              mobile ? "x" : collapsed
                ? "layout-sidebar-left-expand"
                : "layout-sidebar-left-collapse"
            }
            size={16}
          />
        </button>
      </div>
      <nav>
        <a
          href={"https://internal.110-lab.cn/workbench"}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="home" />
          <span>工作台</span>
        </a>
        <a
          href={"https://internal.110-lab.cn/projects"}
          target="_blank"
          rel="noreferrer"
        >
          <img className="icon" src="/relay/assets/kick.png" alt="" />
          <span>项目</span>
        </a>
        <a
          href="https://internal.110-lab.cn/workbench#apps"
        >
          <Icon name="apps" />
          <span>应用</span>
        </a>
      </nav>
      <div className="favorites">
        <h2>收藏</h2>
        {navigation?.favorites?.map(app=>(
          <a key={app.id} href={app.allowed?app.url:undefined} aria-disabled={!app.allowed||undefined} aria-current={app.id==='relay'?'page':undefined} title={app.allowed?app.title:app.reason}>
            {app.iconUrl?<img className="icon" src={app.iconUrl} width="21" height="21" alt=""/>:<Icon name={({'grading':'file-text','mail':'mail','home':'home','honors':'file-text','organization':'user','updates':'file-text'})[app.icon]||'apps'}/>}
            <span>{app.title}</span>
          </a>
        ))}
        {!navigation && <span className="favorites-hint">{requiresLogin?'登录后同步收藏':navigationError?'收藏暂时无法同步':'正在同步'}</span>}
        {navigation?.favorites?.length===0&&<a href="https://internal.110-lab.cn/workbench#apps"><Icon name="apps"/><span>收藏常用应用</span></a>}
        {navigation && navigationError&&<span className="favorites-hint">同步暂时中断</span>}
      </div>
      <div className="sidebar-user">
        <Avatar small />
        <span>{requiresLogin ? "未登录" : profile?.name || (connected ? "成员" : "连接中")}</span>
        <Icon name="chevron-down" size={14} />
      </div>
    </aside>
  );
}
function Badge({ status }) {
  return (
    <span className={"badge " + status}>
      {STATUS[status] ||
        { new: "待接待", open: "进行中", resolved: "已结束" }[status]}
    </span>
  );
}
function PrototypeSwitch({ operator }) {
  return (
    <div className="prototype-switch">
      <span className="prototype-label">本地联调</span>
      <div className="segmented">
        <a
          className={!operator && view !== "embed" ? "active" : ""}
          href="?view=customer"
        >
          用户端
        </a>
        <a className={operator ? "active" : ""} href="?view=operator">
          运营端
        </a>
      </div>
      <a className="quiet-link" href="?view=embed">
        悬浮入口
        <Icon name="arrow-up-right" size={14} />
      </a>
    </div>
  );
}
function SecureImage({ src, alt, ...props }) {
  const [url, setUrl] = useState(
    bridgedWidget && src?.startsWith("/relay/api/") ? "" : src,
  );
  const [error, setError] = useState("");
  useEffect(() => {
    if (!bridgedWidget || !src?.startsWith("/relay/api/")) {
      setUrl(src);
      return;
    }
    const controller = new AbortController();
    let objectUrl = "";
    assetBlob(src, controller.signal)
      .then((blob) => {
        if (!controller.signal.aborted) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  return url ? (
    <img src={url} alt={alt} {...props} />
  ) : (
    <span>{error || "图片加载中…"}</span>
  );
}
async function downloadAttachment(event, item) {
  if (!bridgedWidget || !item.url?.startsWith("/relay/api/")) return;
  event.preventDefault();
  const blob = await assetBlob(item.url),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = item.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function Attachment({ item, onPreview }) {
  return item.kind === "image" ? (
    <button
      className="image-attachment"
      onClick={() => onPreview(item)}
      aria-label={"查看 " + item.name}
    >
      <SecureImage src={item.url} alt={item.name} />
      <span>{item.name}</span>
    </button>
  ) : (
    <button className="file-attachment" onClick={() => onPreview(item)}>
      <div>
        <Icon name={item.kind === "text" ? "file-code" : "file-text"} />
        <strong>{item.name}</strong>
        <span>{item.size}</span>
        <Icon name="arrow-up-right" size={14} />
      </div>
      {item.content && (
        <pre>{item.content.split("\n").slice(0, 3).join("\n")}</pre>
      )}
    </button>
  );
}
function Messages({ conversation, operator, onPreview, onTicket, onRetry, onRead }) {
  const bottom = useRef(),
    viewport = useRef(),
    followBottom = useRef(true), seenCount = useRef(conversation.messages.length);
  const [newCount, setNewCount] = useState(0);
  const unreadKey = (conversation.unreadMessageIds || []).join(",");
  useEffect(() => {
    if (!conversation.id || !unreadKey || !viewport.current) return;
    return observeReadReplies({
      root: viewport.current,
      ids: unreadKey.split(","),
      embedded: bridgedWidget,
      app: sourceApp,
      ack: async (messageId) => {
        await mutation(
          "/api/relay/conversations/" + conversation.id + "/read" + (operator?"?view=operator":""),
          { messageId },
        );
        onRead?.(conversation.id, messageId);
        if (bridgedWidget)
          window.parent.postMessage(
            { type: "RELAY_UNREAD_REFRESH", app: sourceApp },
            "*",
          );
      },
    });
  }, [conversation.id, operator, unreadKey]);
  useEffect(() => {
    followBottom.current = true;
    seenCount.current = conversation.messages.length;
    setNewCount(0);
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [conversation.id]);
  useEffect(() => {
    if (followBottom.current) {
      bottom.current?.scrollIntoView({ block: "nearest" });
      setNewCount(0);
    } else if (conversation.messages.length > seenCount.current) {
      setNewCount(n => n + conversation.messages.length - seenCount.current);
    }
    seenCount.current = conversation.messages.length;
  }, [conversation.messages.length]);
  return (
    <div className="message-pane">
    <div
      className="messages"
      ref={viewport}
      onScroll={() => {
        const el = viewport.current;
        followBottom.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        if (followBottom.current) setNewCount(0);
      }}
    >
      <div className="date-divider">
        {conversation.createdAt
          ? new Date(conversation.createdAt).toLocaleDateString("zh-CN", {
              timeZone: "Asia/Shanghai",
            })
          : ""}
      </div>
      {visibleMessages(conversation, operator).map((m) =>
        m.side === "system" ? (
          <div className="system-message" key={m.id}>
            {operator ? (
              <button onClick={() => m.ticketId && onTicket(m.ticketId)}>
                <Icon name="ticket" size={14} />
                {m.content}
                <Icon name="chevron-right" size={13} />
              </button>
            ) : (
              m.content
            )}
          </div>
        ) : (
          <div
            className={
              "message " +
              (m.side === "customer" ? "from-customer" : "from-operator") +
              ((operator ? m.side === "operator" : m.side === "customer") ? " from-self" : " from-other") +
              (m.private ? " internal" : "") +
              ((conversation.unreadMessageIds || []).includes(m.id) ? " unread-message" : "")
            }
            key={m.id}
            data-reply-id={
              (operator ? m.side === "customer" : m.side === "operator") && !m.private
                ? m.id
                : undefined
            }
          >
            <div className="message-meta">
              {messageSender(m, conversation, operator)}
              <span>{timeText(m.time)}</span>
            </div>
            <div className="message-bubble">
              {m.content && <p>{m.content}</p>}
              {m.attachments?.length > 0 && (
                <div className="message-attachments">
                  {m.attachments.map((item) => (
                    <Attachment
                      key={item.id}
                      item={item}
                      onPreview={onPreview}
                    />
                  ))}
                </div>
              )}
            </div>
            {m.private && <span className="internal-caption">仅运营可见</span>}
            {operator && m.delivery && <div className={"message-delivery " + m.delivery} aria-live="polite">
              {deliveryText(m.delivery)}
              {["failed","unknown"].includes(m.delivery) && <button onClick={()=>onRetry?.(m.clientId)}>{m.delivery === "unknown" ? "重试核对" : "重试"}</button>}
            </div>}
          </div>
        ),
      )}
      <div ref={bottom} />
    </div>
    {newCount > 0 && <button className="new-messages-button" onClick={()=>{followBottom.current=true;setNewCount(0);bottom.current?.scrollIntoView({block:"nearest"});}}>{newCount} 条新消息 ↓</button>}
    </div>
  );
}
function Composer({ operator, onSend, notify, readOnly = false }) {
  const [text, setText] = useState(""),
    [files, setFiles] = useState([]),
    [internal, setInternal] = useState(false),
    [sending, setSending] = useState(false),
    input = useRef(),
    messageKey = useRef(crypto.randomUUID());
  function addFiles(event) {
    for (const file of event.target.files) {
      if (file.size > 2 * 1024 * 1024) {
        notify("文件超过 2 MB，请选择较小的文件");
        continue;
      }
      const id = crypto.randomUUID(),
        isImage = /^image\/(png|jpeg|webp|gif)$/.test(file.type),
        isText =
          /\.(txt|md|py|js|jsx|ts|tsx|json|csv|go|java|rs|css|html)$/i.test(
            file.name,
          );
      setFiles((prev) => [
        ...prev,
        {
          id,
          name: file.name,
          kind: isImage ? "image" : isText ? "text" : "file",
          size:
            file.size < 1024
              ? file.size + " B"
              : Math.round(file.size / 1024) + " KB",
          progress: 0,
        },
      ]);
      const reader = new FileReader();
      reader.onprogress = (e) => {
        if (e.lengthComputable)
          setFiles((prev) =>
            prev.map((f) =>
              f.id === id
                ? { ...f, progress: Math.round((e.loaded / e.total) * 100) }
                : f,
            ),
          );
      };
      reader.onload = () =>
        setFiles((prev) =>
          prev.map((f) =>
            f.id !== id
              ? f
              : {
                  ...f,
                  progress: 100,
                  url: isText
                    ? "data:text/plain;charset=utf-8," +
                      encodeURIComponent(String(reader.result))
                    : String(reader.result),
                  content: isText
                    ? String(reader.result).slice(0, 20000)
                    : undefined,
                },
          ),
        );
      reader.onerror = () => {
        setFiles((prev) => prev.filter((f) => f.id !== id));
        notify("文件读取失败，请重新添加");
      };
      if (isText) reader.readAsText(file);
      else reader.readAsDataURL(file);
    }
    event.target.value = "";
  }
  async function send() {
    if (readOnly) return;
    if (
      sending ||
      (!text.trim() && !files.length) ||
      files.some((f) => f.progress < 100)
    )
      return;
    setSending(true);
    try {
      await onSend(
        {
          content: text.trim(),
          attachments: files.map(({ progress, ...item }) => item),
          private: operator && internal,
        },
        messageKey.current,
      );
      setText("");
      setFiles([]);
      messageKey.current = crypto.randomUUID();
    } catch (e) {
      notify(e.message);
    } finally {
      setSending(false);
    }
  }
  return (
    <fieldset
      disabled={readOnly}
      style={{ border: 0, margin: 0, minWidth: 0 }}
      className={"composer " + (operator && internal ? "note-composer" : "")}
    >
      {operator && (
        <div className="reply-tabs">
          <button
            disabled={sending}
            aria-pressed={!internal}
            onClick={() => setInternal(false)}
          >
            回复用户
          </button>
          <button
            disabled={sending}
            aria-pressed={internal}
            onClick={() => setInternal(true)}
          >
            内部备注
          </button>
          {internal && <span>仅运营可见</span>}
        </div>
      )}
      {files.length > 0 && (
        <div className="pending-files">
          {files.map((f) => (
            <div className="pending-file" key={f.id}>
              {f.kind === "image" && f.url ? (
                <img className="pending-thumb" src={f.url} alt="" />
              ) : (
                <Icon name="file-text" />
              )}
              <div>
                <strong>{f.name}</strong>
                <small>
                  {f.progress < 100 ? "读取中 " + f.progress + "%" : "已添加"}
                </small>
                {f.progress < 100 && <progress value={f.progress} max="100" />}
              </div>
              <button
                className="icon-button"
                disabled={sending}
                aria-label={"移除 " + f.name}
                onClick={() =>
                  setFiles((prev) => prev.filter((x) => x.id !== f.id))
                }
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        disabled={sending}
        aria-label={operator && internal ? "内部备注" : "消息内容"}
        placeholder={operator && internal ? "添加内部备注…" : "输入消息…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-tools">
        <input
          type="file"
          ref={input}
          multiple
          disabled={sending}
          className="hidden-file"
          onChange={addFiles}
        />
        <button
          className="icon-button"
          disabled={sending}
          aria-label="添加附件"
          title="添加附件"
          onClick={() => input.current.click()}
        >
          <Icon name="paperclip" />
        </button>
        <span className="keyboard-hint">⌘ / Ctrl + Enter 发送</span>
        <button
          className="button primary send-button"
          disabled={
            sending ||
            (!text.trim() && !files.length) ||
            files.some((f) => f.progress < 100)
          }
          onClick={send}
        >
          {sending ? "发送中" : operator && internal ? "保存备注" : "发送"}
          <Icon name="arrow-up" size={15} />
        </button>
      </div>
    </fieldset>
  );
}
function Chat({
  conversation,
  onClaim,
  onBegin,
  operator,
  state,
  onSend,
  onPreview,
  onTicket,
  notify,
  onResolve,
  onManageTicket,
  ticketExists,
  onShowList,
  onShowContext,
  onAiMode,
  onRetry,
  onRead,
}) {
  const chatRef = useRef(null);
  useEffect(() => {
    const motion = createContentMotion();
    motion.enter(chatRef.current, conversation.id);
    return () => motion.dispose();
  }, [conversation.id]);
  const canReply =
    !operator || (conversation.receptionist?.id === state.profile?.id && conversation.ai?.mode !== "ai");
  return (
    <section ref={chatRef} className="chat">
      <header className="chat-head">
        {operator && (
          <button
            className="icon-button mobile-back"
            aria-label="返回咨询列表"
            onClick={onShowList}
          >
            <Icon name="arrow-left" size={16} />
          </button>
        )}
        {operator ? (
          <Avatar />
        ) : (
          <img className="support-mark" src="/relay/assets/relay.svg" alt="" />
        )}
        <div className="chat-person">
          <strong>{operator ? conversation.name : "小助手"}</strong>
          <p>
            {operator ? (
              <>
                <Mark app={conversation.app} size={13} />
                {APPS[conversation.app].name}
                <span>·</span>
                {conversation.ai?.mode === "ai" ? (conversation.ai?.state === "generating" ? "AI 正在回复…" : "AI 接待中") : conversation.ai?.state === "error" ? "AI 暂不可用 · 待人工接待" : conversation.title}
              </>
            ) : (
              <>
                <span
                  className={"presence " + (state.online ? "" : "offline")}
                />
                {state.online ? "在线" : "离线，可留言"}
                <span>·</span>
                {APPS[conversation.app].name}
              </>
            )}
          </p>
        </div>
        {operator && (
          <button className="icon-button context-toggle" aria-label="查看咨询详情" onClick={onShowContext}>
            <Icon name="info-circle" size={18} />
          </button>
        )}
        {operator ? (
          <div className="chat-actions">
            {!canReply && (
              <button className="button primary small-button" onClick={onClaim}>
                {conversation.ai?.mode === "ai" ? "人工接管" : "接待会话"}
              </button>
            )}
            {canReply && conversation.ai?.available && conversation.state !== "resolved" && <button className="button small-button" onClick={()=>onAiMode("ai")}>恢复 AI 接待</button>}
            <button
              className="button small-button ticket-action"
              aria-label={ticketExists ? "查看关联工单" : "转为工单"}
              disabled={!ticketExists && !canReply}
              onClick={onManageTicket}
            >
              <Icon name="ticket" size={15} />
              <span>{ticketExists ? "查看工单" : "转为工单"}</span>
            </button>
            <button
              className="button small-button"
              aria-label={
                conversation.state === "resolved" ? "重新打开咨询" : "结束咨询"
              }
              disabled={!canReply}
              onClick={onResolve}
            >
              <Icon name="circle-check" size={15} />
              {conversation.state === "resolved" ? "重新打开" : "结束咨询"}
            </button>
          </div>
        ) : (
          <>
            {conversation.state === "resolved" && (
              <button
                className="button small-button new-conversation-button"
                onClick={onBegin}
                aria-label="开启新会话"
                title="开启新会话"
              >
                <Icon name="plus" size={15} />
                <span>新会话</span>
              </button>
            )}
            {view === "widget" && (
              <button
                className="icon-button"
                aria-label="关闭客服"
                onClick={() =>
                  window.parent.postMessage({ type: "RELAY_CLOSE" }, "*")
                }
              >
                <Icon name="x" size={18} />
              </button>
            )}
          </>
        )}
      </header>
      {conversation.syncPending && <p className="sync-pending" role="status">消息暂未同步，正在重试。</p>}
      <Messages
        conversation={conversation}
        operator={operator}
        onPreview={onPreview}
        onTicket={onTicket}
        onRetry={onRetry}
        onRead={onRead}
      />
      <Composer
        key={conversation.id}
        operator={operator}
        readOnly={
          !canReply || !conversation.id || conversation.state === "resolved" || conversation.syncPending
        }
        onSend={onSend}
        notify={notify}
      />
    </section>
  );
}
function TicketList({
  tickets,
  conversations,
  onOpen,
  operator,
  filter,
  setFilter,
  search,
  setSearch,
}) {
  const filtered = tickets.filter(
    (t) =>
      (filter === "all" || t.status === filter) &&
      (
        t.id +
        " " +
        t.title +
        " " +
        conversations.find((c) => c.id === t.conversationId)?.name
      ).includes(search),
  );
  return (
    <section className="ticket-list">
      <div className="ticket-toolbar">
        <div className="ticket-filters">
          {[
            ["all", "全部"],
            ["pending", "待分派"],
            ["processing", "处理中"],
            ["waiting", "待补充"],
            ["resolved", "已解决"],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
              <span>
                {
                  tickets.filter((t) => key === "all" || t.status === key)
                    .length
                }
              </span>
            </button>
          ))}
        </div>
        <label className="search">
          <Icon name="search" size={15} />
          <input
            aria-label="搜索工单"
            placeholder="搜索工单"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>工单</th>
              {operator && <th>用户 / 应用</th>}
              <th>状态</th>
              <th>优先级</th>
              <th>处理人</th>
              <th>创建时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => {
              const c = conversations.find((c) => c.id === t.conversationId);
              return (
                <tr key={t.id}>
                  <td data-label="工单">
                    <button
                      className="ticket-title"
                      onClick={() => onOpen(t.id)}
                    >
                      <span>{t.code || t.id}</span>
                      <strong>{t.title}</strong>
                    </button>
                  </td>
                  {operator && (
                    <td data-label="用户 / 应用">
                      <div>{c?.name || "—"}</div>
                      <small>{APPS[c?.app]?.name || "—"}</small>
                    </td>
                  )}
                  <td data-label="状态">
                    <Badge status={t.status} />
                    {t.syncState === "stale" && <small>状态待同步</small>}
                  </td>
                  <td data-label="优先级">
                    <span className={"priority " + t.priority}>
                      <span />
                      {PRIORITY[t.priority]}
                    </span>
                  </td>
                  <td data-label="处理人">{t.owner}</td>
                  <td data-label="创建时间" className="muted">{t.created}</td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={"打开工单 " + t.id}
                      onClick={() => onOpen(t.id)}
                    >
                      <Icon name="chevron-right" size={16} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length && (
          <div className="empty">
            <Icon name="ticket" size={30} />
            <strong>{search ? "没有找到匹配的工单" : "暂无工单"}</strong>
            <p>
              {operator
                ? "需要进一步处理的咨询会出现在这里。"
                : "运营创建工单后，你可以在这里查看进展。"}
            </p>
          </div>
        )}
      </div>
      <footer>{filtered.length} 个工单</footer>
    </section>
  );
}
function ConvertDialog({ conversation, onClose, onCreate }) {
  const [title, setTitle] = useState(conversation.title),
    [description, setDescription] = useState(""),
    [priority, setPriority] = useState("normal"),
    [owners, setOwners] = useState(["lin"]),
    [error, setError] = useState(""),
    [context, setContext] = useState(null),
    [members, setMembers] = useState([]),
    [saving, setSaving] = useState(false),
    ref = useRef(),
    key = useRef(crypto.randomUUID());
  useEffect(() => {
    ref.current.showModal();
    let cancelled = false;
    Promise.all([
      request("/api/support/context/" + conversation.id + "?client=relay"),
      request("/api/support/members?client=relay"),
    ])
      .then(([snapshot, people]) => {
        if (cancelled) return;
        setContext(snapshot);
        setMembers(people);
        setOwners(people.filter((p) => p.isCurrent).map((p) => p.id));
        setDescription(
          snapshot.messages
            .filter((m) => m.side === "customer")
            .map((m) => m.content)
            .filter(Boolean)
            .join("\n\n"),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);
  async function submit(e) {
    e.preventDefault();
    if (saving || !context) return;
    if (!title.trim()) {
      setError("请填写工单标题");
      return;
    }
    setSaving(true);
    try {
      await onCreate({ title, description, priority, owners }, key.current);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        if (saving) e.preventDefault();
        else onClose();
      }}
      aria-labelledby="convert-title"
    >
      <form noValidate onSubmit={submit}>
        <header>
          <div>
            <span className="eyebrow">Makit · 工单项目</span>
            <h2 id="convert-title">转为工单</h2>
          </div>
          <button
            type="button"
            disabled={saving}
            className="icon-button"
            aria-label="关闭转工单窗口"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <fieldset disabled={saving} className="modal-body">
          <div className="source-chip">
            <Mark app={conversation.app} size={20} />
            {APPS[conversation.app].name}
            <span>·</span>
            {conversation.name}
          </div>
          <label className="field">
            <span>工单标题</span>
            <input
              aria-label="工单标题"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setError("");
              }}
              maxLength={200}
            />
          </label>
          <label className="field">
            <span>问题描述</span>
            <textarea
              aria-label="问题描述"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="form-row">
            <label className="field">
              <span>优先级</span>
              <Select
                label="优先级"
                value={priority}
                options={Object.entries(PRIORITY).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={setPriority}
              />
            </label>
            <fieldset className="field people-multi">
              <legend>当前处理人</legend>
              <div>
                {members.map((m) => (
                  <label key={m.id}>
                    <input
                      type="checkbox"
                      checked={owners.includes(m.id)}
                      onChange={(e) =>
                        setOwners(
                          e.target.checked
                            ? [...owners, m.id]
                            : owners.filter((id) => id !== m.id),
                        )
                      }
                    />
                    {m.name}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <details className="context-preview">
            <summary>
              {context
                ? "已带入 " +
                  context.messages.length +
                  " 条对话 · " +
                  context.messages.reduce(
                    (n, m) => n + (m.attachments?.length || 0),
                    0,
                  ) +
                  " 个附件"
                : "正在加载对话上下文…"}
            </summary>
            <div>
              {context?.messages.map((m) => (
                <p key={m.id}>
                  <strong>
                    {m.private
                      ? "内部备注"
                      : m.side === "customer"
                        ? context.customerName
                        : "客服"}
                  </strong>
                  {m.content}
                </p>
              ))}
            </div>
          </details>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </fieldset>
        <footer>
          <button
            type="button"
            disabled={saving}
            className="button"
            onClick={onClose}
          >
            取消
          </button>
          <button
            disabled={saving || !context}
            className="button primary"
            type="submit"
          >
            {saving ? "正在创建" : "创建工单"}
            <Icon name="arrow-up-right" size={15} />
          </button>
        </footer>
      </form>
    </dialog>
  );
}
function PreviewDialog({ item, onClose }) {
  const [downloadError, setDownloadError] = useState("");
  const ref = useRef();
  useEffect(() => {
    if (!ref.current.open) ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal preview-modal"
      onCancel={onClose}
      aria-label={item.name}
    >
      <header>
        <h2>{item.name}</h2>
        <button
          className="icon-button"
          aria-label="关闭附件预览"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </header>
      <div className="attachment-preview">
        {item.kind === "image" ? (
          <SecureImage src={item.url} alt={item.name} />
        ) : item.content ? (
          <pre>{item.content}</pre>
        ) : (
          <div className="empty">
            <Icon name="file-text" size={40} />
            <strong>{item.name}</strong>
          </div>
        )}
      </div>
      <footer>
        <span className="muted">{downloadError || item.size}</span>
        <a
          className="button"
          href={item.url}
          download={item.name}
          onClick={(event) => {
            setDownloadError("");
            downloadAttachment(event, item).catch((e) =>
              setDownloadError(e.message),
            );
          }}
        >
          <Icon name="download" size={16} />
          下载文件
        </a>
      </footer>
    </dialog>
  );
}
function ContextPanel({
  canConvert,
  conversation,
  ticket,
  onConvert,
  onTicket,
  onSource,
  onReply,
}) {
  return (
    <aside className="context-panel">
      <section>
        <div className="person-heading">
          <Avatar />
          <div>
            <strong>{conversation.name}</strong>
            <span>已登录用户</span>
          </div>
        </div>
        <dl>
          <dt>来源应用</dt>
          <dd>
            <Mark app={conversation.app} size={19} />
            {APPS[conversation.app].name}
          </dd>
          <dt>接待人</dt>
          <dd>{conversation.owner}</dd>
        </dl>
        <button className="button context-source" onClick={onSource}>
          查看来源信息
          <Icon name="arrow-up-right" size={14} />
        </button>
      </section>
      <section>
        <h3>关联工单{ticket && <span>1</span>}</h3>
        {ticket ? (
          <>
            <button
              className="linked-ticket"
              onClick={() => onTicket(ticket.id)}
            >
              <span>
                {ticket.code || ticket.id}
                <Icon name="arrow-up-right" size={14} />
              </span>
              <strong>{ticket.title}</strong>
              <Badge status={ticket.status} />
            </button>
            {!ticket.live && ["resolved", "closed"].includes(ticket.status) && (
              <button
                className="button new-ticket-button"
                disabled={!canConvert}
                onClick={onConvert}
              >
                <Icon name="plus" size={14} />
                新建工单
              </button>
            )}
          </>
        ) : (
          <>
            <p className="muted context-hint">需要进一步处理时，转为工单。</p>
            <button
              className="button primary"
              disabled={!canConvert}
              onClick={onConvert}
            >
              <Icon name="ticket" size={16} />
              转为工单
            </button>
          </>
        )}
        {ticket?.replies
          ?.filter((r) => r.state === "draft")
          .map((r) => (
            <div className="reply-draft" key={r.id}>
              <span>待发送回复</span>
              <p>{r.content}</p>
              <button
                className="button primary"
                onClick={() => onReply(ticket.id, r.id)}
              >
                发送给用户
              </button>
            </div>
          ))}
      </section>
      <section>
        <h3>咨询信息</h3>
        <dl>
          <dt>开始时间</dt>
          <dd>
            {conversation.createdAt
              ? new Date(conversation.createdAt).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })
              : "—"}
          </dd>
          <dt>渠道</dt>
          <dd>应用内咨询</dd>
        </dl>
      </section>
    </aside>
  );
}
function Host({ open, setOpen, state }) {
  const frame = useRef(),
    drag = useRef(null),
    suppressClick = useRef(false);
  const [viewport, setViewport] = useState(() => ({
    width: innerWidth || 1280,
    height: innerHeight || 720,
  }));
  const [position, setPosition] = useState(() => {
    let saved;
    try {
      saved = JSON.parse(
        localStorage.getItem("cobuild-relay-launcher-position-v1"),
      );
    } catch {}
    return launcherPosition(saved, {
      width: innerWidth || 1280,
      height: innerHeight || 720,
    });
  });
  const [dragging, setDragging] = useState(false);
  const remember = (next) => {
    try {
      localStorage.setItem(
        "cobuild-relay-launcher-position-v1",
        JSON.stringify(next),
      );
    } catch {}
  };
  useEffect(() => {
    function resize() {
      if (!innerWidth || !innerHeight) return;
      const nextViewport = { width: innerWidth, height: innerHeight };
      setViewport(nextViewport);
      setPosition((previous) => {
        const next = launcherPosition(previous, nextViewport);
        remember(next);
        return next;
      });
    }
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    function message(e) {
      if (
        e.origin !== location.origin ||
        e.source !== frame.current?.contentWindow
      )
        return;
      if (e.data?.type === "RELAY_CLOSE") setOpen(false);
    }
    addEventListener("message", message);
    return () => removeEventListener("message", message);
  }, [setOpen]);
  function startDrag(e) {
    if (!e.isPrimary || e.button !== 0) return;
    suppressClick.current = false;
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      start: position,
      last: position,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveDrag(e) {
    const current = drag.current;
    if (!current || current.id !== e.pointerId) return;
    const dx = e.clientX - current.x,
      dy = e.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 6) return;
    current.moved = true;
    setDragging(true);
    suppressClick.current = true;
    current.last = launcherPosition(
      { x: current.start.x + dx, y: current.start.y + dy },
      viewport,
    );
    setPosition(current.last);
  }
  function endDrag(e) {
    const current = drag.current;
    if (!current || current.id !== e.pointerId) return;
    remember(current.last);
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const targets = {
    Kick: "https://internal.110-lab.cn/projects",
    WeKnow: "https://knowledge.110-lab.cn/home",
    Makit: "http://127.0.0.1:5422/projects/relay-support",
    HiFlow: "https://internal.110-lab.cn/recruitment",
    Evalab: "https://exam.110-lab.cn/login",
  };
  const cards = [
    ["kick.png", "Kick", "项目立项", "发起项目，组建团队并推进协作。"],
    ["weknow.png", "WeKnow", "知识库", "文档、资料与团队协作。"],
    [
      "requirements-logo.svg",
      "Makit",
      "需求平台",
      "集中提交需求，协作推进项目与迭代。",
    ],
    ["relay.svg", "Relay", "客服与工单", "咨询问题，跟踪处理进展。"],
    ["hiflow.png", "HiFlow", "招新管理", "简历、面试安排与通知。"],
    ["evalab.png", "Evalab", "考核系统", "报名、作答、提交与评审。"],
  ];
  return (
    <>
      <div className="host-heading">
        <h1>应用</h1>
        {state.mode !== "live-chatwoot" && <PrototypeSwitch operator={false} />}
      </div>
      <div className="host-tabs">
        <button aria-pressed="true">全部应用</button>
        <span>{cards.length} 个应用</span>
      </div>
      <div className="host-apps">
        {cards.map(([icon, name, kind, description]) => (
          <a
            key={name}
            href={name === "Relay" ? "?view=customer" : targets[name]}
            target={name === "Relay" ? undefined : "_blank"}
            rel="noreferrer"
          >
            <img src={"/relay/assets/" + icon} alt="" />
            <div>
              <h2>
                {name}
                <small>{kind}</small>
              </h2>
              <p>{description}</p>
            </div>
            <Icon name="arrow-up-right" size={16} />
          </a>
        ))}
      </div>
      {open && (
        <div className="widget-frame" style={panelPosition(position, viewport)}>
          <iframe title="Relay 客服悬浮窗" src="?view=widget" ref={frame} />
        </div>
      )}
      <button
        className={
          "launcher " +
          (open ? "is-open " : "") +
          (dragging ? "is-dragging" : "")
        }
        style={{ left: position.x, top: position.y }}
        aria-label={open ? "关闭客服" : "打开客服"}
        aria-description="拖动可调整位置，点击打开或关闭客服"
        aria-expanded={open}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onClick={(e) => {
          if (e.detail !== 0 && suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          setOpen(!open);
        }}
      >
        {open ? (
          <Icon name="x" size={22} />
        ) : (
          <img src="/relay/assets/relay.svg" alt="" />
        )}
      </button>
    </>
  );
}
export function App() {
  const operator = view === "operator",
    widget = view === "widget";
  const [state, setState] = useState(() => ({
    online: false,
    mode: "live-chatwoot",
    profile: null,
    conversations: [],
    tickets: [],
  }));
  const [outbox, setOutbox] = useState([]);
  const outboxRef = useRef([]);
  function updateOutbox(fn) { setOutbox(previous => { const next = fn(previous); outboxRef.current = next; return next; }); }
  const [connected, setConnected] = useState(false),
    [loadError, setLoadError] = useState(null);
  const refreshing = useRef(false),
    authenticationRequired = useRef(false);
  function connectionFailed(error) {
    const failure = connectionFailure(error, bridgedWidget);
    authenticationRequired.current = failure.action === "login";
    if (authenticationRequired.current) setConnected(false);
    setLoadError(failure);
  }
  const requestedSelection = useRef(query.get("conversation") || "");
  async function refresh() {
    if (refreshing.current || authenticationRequired.current) return;
    refreshing.current = true;
    try {
      let next = await readState(operator);
      if (
        next.mode === "live-chatwoot" &&
        !operator &&
        !next.conversations.length
      ) {
        let key = sessionStorage.getItem("relay-begin-key:" + sourceApp);
        if (!key) {
          key = crypto.randomUUID();
          sessionStorage.setItem("relay-begin-key:" + sourceApp, key);
        }
        await mutation(
          "/api/relay/conversations",
          { app: sourceApp },
          "POST",
          key,
        );
        next = await readState(operator);
      }
      if(authenticationRequired.current)return;
      setState(next);
      updateOutbox(previous => pruneOutbox(previous, next.conversations));
      setConnected(true); // Successful polling also recovers an initially failed connection.
      const requested = next.conversations.find(
        (c) => c.id === requestedSelection.current,
      );
      if (operator && requested)
        setTab(requested.state === "resolved" ? "ended" : "inbox");
      setSelected((previous) => {
        if (requestedSelection.current) {
          const requested = requestedSelection.current;
          if (next.conversations.some((c) => c.id === requested))
            requestedSelection.current = "";
          return requested;
        }
        return next.conversations.some((c) => c.id === previous)
          ? previous
          : next.conversations[0]?.id || "";
      });
      setLoadError(null);
    } finally {
      refreshing.current = false;
    }
  }
  const [tab, setTab] = useState(
      operator && ["tickets", "ended"].includes(query.get("tab"))
        ? query.get("tab")
        : "inbox",
    ),
    [selected, setSelected] = useState(query.get("conversation") || ""),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [queue, setQueue] = useState("all"),
    [preview, setPreview] = useState(null),
    [convert, setConvert] = useState(false),
    [source, setSource] = useState(false),
    [toast, setToast] = useState(""),
    [collapsed, setCollapsed] = useState(false),
    [hostOpen, setHostOpen] = useState(true),
    [mobileListOpen, setMobileListOpen] = useState(!query.get("conversation")),
    [mobileNavigationOpen, setMobileNavigationOpen] = useState(false),
    [contextOpen, setContextOpen] = useState(false);
  const viewportHeight = useViewportHeight();
  useEffect(() => { setContextOpen(false); }, [selected, tab]);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width:900px)");
    const update = () => { if (!narrow.matches) setMobileNavigationOpen(false); };
    narrow.addEventListener("change", update);
    return () => narrow.removeEventListener("change", update);
  }, []);
  const displayedConversations = mergeOutbox(state.conversations, outbox);
  const bucket = conversationBucket(displayedConversations, operator, tab);
  const list = filterConversations(bucket,{queue,employeeId:state.profile?.id,search,appName:app=>APPS[app]?.name||app});
  const conversation = selectedConversation(operator ? list : bucket, selected) || {
      id: "",
      name: state.profile?.name || "",
      app: APPS[sourceApp] ? sourceApp : "makit",
      title: "咨询",
      state: "new",
      owner: "客服",
      messages: [],
    },
    linked = state.tickets.find((t) => t.conversationId === conversation?.id);
  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        await connect(operator);
        if (disposed) return;
        await refresh();
        if (!disposed) setConnected(true);
      } catch (e) {
        if (!disposed) connectionFailed(e);
      }
    }
    void load();
    const timer = setInterval(() => {
      if (!disposed) refresh().catch((e) => connectionFailed(e));
    }, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [operator]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  function openTicket(id) {
    window.open(
      state.tickets.find((t) => t.id === id)?.nativeUrl ||
        (state.mode === "live-chatwoot"
          ? "/tickets/"
          : "http://127.0.0.1:5422/tickets/") + encodeURIComponent(id),
      "_blank",
      "noopener,noreferrer",
    );
  }
  const beginKey = useRef(null);
  async function beginAgain() {
    if (!beginKey.current) beginKey.current = crypto.randomUUID();
    try {
      const created = await mutation(
        "/api/relay/conversations",
        { app: conversation.app },
        "POST",
        beginKey.current,
      );
      requestedSelection.current = created.id;
      setSelected(created.id);
      sessionStorage.setItem("relay-begin-key:" + sourceApp, beginKey.current);
      beginKey.current = null;
      await refresh();
    } catch (e) {
      setToast(e.message);
    }
  }
  async function deliver(message) {
    updateOutbox(previous => previous.map(m=>m.clientId===message.clientId ? {...m,delivery:"sending"} : m));
    try {
      const result = await mutation("/api/relay/conversations/" + message.conversationId + "/messages?view=" + (operator ? "operator" : "customer"), message.input, "POST", message.clientId);
      updateOutbox(previous => previous.map(m=>m.clientId===message.clientId ? {...m,remoteId:result.id,delivery: m.private ? "sent" : "unread"} : m));
      void refresh().catch(e=>setToast(e.message));
    } catch (e) {
      const delivery = e.status >= 400 && e.status < 500 && e.status !== 409 ? "failed" : "unknown";
      updateOutbox(previous => previous.map(m=>m.clientId===message.clientId ? {...m,delivery} : m));
      setToast(e.message);
    }
  }
  function send(input, key) {
    const message = {id:"local-"+key,clientId:key,conversationId:conversation.id,input,side:operator?"operator":"customer",senderName:operator?state.profile?.name:"我",time:new Date().toISOString(),content:input.content,attachments:input.attachments,private:input.private,delivery:"sending"};
    updateOutbox(previous => [...previous,message]);
    void deliver(message);
  }
  function retryMessage(key) {
    const message = outboxRef.current.find(m=>m.clientId===key);
    if(message && message.delivery !== "sending") void deliver(message);
  }
  function acknowledgeRead(id, through) {
    setState(previous=>({...previous,conversations:previous.conversations.map(c=>{
      if(c.id!==id)return c;
      const ids=(c.unreadMessageIds||[]).filter(m=>Number(m)>Number(through));
      return {...c,unreadMessageIds:ids,unread:ids.length>0};
    })}));
  }
  async function changeAiMode(mode) {
    try { await mutation("/api/relay/conversations/"+conversation.id+"/ai-mode?view=operator",{mode}); await refresh(); }
    catch(e) {setToast(e.message);}
  }
  async function resolve() {
    const reopening = conversation.state === "resolved";
    try {
      await mutation(
        "/api/relay/conversations/" +
          conversation.id +
          "/resolve?view=operator",
        state.mode === "live-chatwoot"
          ? { status: conversation.state === "resolved" ? "open" : "resolved" }
          : {},
      );
      requestedSelection.current = "";
      setSelected("");
      if (reopening) setTab("inbox");
      await refresh();
      setToast(reopening ? "咨询已重新打开" : "咨询已结束，已收至“已结束”");
    } catch (e) {
      setToast(e.message);
    }
  }
  async function convertTicket(input, key) {
    const created = await mutation(
      "/api/support/tickets",
      {
        conversationId: conversation.id,
        title: input.title,
        description: input.description,
        priority: { normal: "普通", high: "紧急", low: "较低" }[input.priority],
        handlerIds: input.owners || [],
      },
      "POST",
      key,
    );
    await refresh();
    setConvert(false);
    setToast("工单 " + created.code + " 已关联到 Makit");
  }
  async function sendReply(id, replyId) {
    try {
      await mutation(
        "/api/support/tickets/" + id + "/replies/" + replyId + "/send",
        {},
        "POST",
        "reply-" + replyId,
      );
      await refresh();
      setToast("回复已发送给用户");
    } catch (e) {
      setToast(e.message);
    }
  }
  const ownTickets = operator
    ? state.tickets
    : state.tickets.filter((t) => t.conversationId === conversation.id);
  function chooseConversation(id) {
    requestedSelection.current = "";
    setSelected(id);
    setMobileListOpen(false);

  }
  const ticketContent = (
    <TicketList
      tickets={ownTickets}
      conversations={state.conversations}
      operator={operator}
      onOpen={openTicket}
      filter={filter}
      setFilter={setFilter}
      search={search}
      setSearch={setSearch}
    />
  );
  return (
    <div
      className={
        "app-shell " + (operator ? "operator-mode " : "") +
        (collapsed ? "sidebar-small " : "") +
        (widget ? "widget-mode" : view === "customer" ? "customer-mode" : "")
      }
      style={{ "--app-height": viewportHeight + "px" }}
    >
      {!widget && view !== "customer" && (
        <Sidebar
          operator={operator}
          profile={state.profile}
          connected={connected}
          requiresLogin={loadError?.action === "login"}
          collapsed={collapsed}
          onCollapse={() => setCollapsed(!collapsed)}
        />
      )}
      <main>
        {loadError && (
          <p className="connection-error" role="alert">
            {loadError.message}
            <button
              className="button"
              onClick={async () => {
                try {
                  if (loadError.action === "login") {
                    await login(operator);
                    if (!bridgedWidget && window.top === window.self) return;
                  } else await connect(operator);
                  authenticationRequired.current = false;
                  await refresh();
                } catch (e) {
                  connectionFailed(e);
                }
              }}
            >
              {loadError.label}
            </button>
          </p>
        )}
        {!connected && !loadError && <p role="status">正在连接…</p>}
        {connected &&
          (view === "embed" ? (
            <Host open={hostOpen} setOpen={setHostOpen} state={state} />
          ) : (
            <>
              {operator ? (
                <header className="page-header">
                  <button className="icon-button mobile-navigation-toggle" aria-label="打开导航" aria-haspopup="dialog" onClick={() => setMobileNavigationOpen(true)}>
                    <Icon name="layout-sidebar-left-expand" size={21} />
                  </button>
                  <div className="page-brand">
                    <img src="/relay/assets/relay.svg" alt="" />
                    <div>
                      <h1>
                        Relay<span>客服与工单</span>
                      </h1>
                    </div>
                  </div>
                  {state.mode !== "live-chatwoot" && (
                    <PrototypeSwitch operator={true} />
                  )}
                </header>
              ) : (
                !widget && (
                  <div className="customer-preview-toolbar">
                    {state.mode !== "live-chatwoot" && (
                      <PrototypeSwitch operator={false} />
                    )}
                  </div>
                )
              )}
              {operator && (
                <nav className="page-tabs" aria-label="Relay 功能">
                  {(operator
                    ? [
                        ["inbox", "收件箱"],
                        ["ended", "已结束"],
                        ["tickets", "工单"],
                      ]
                    : []
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      aria-current={tab === key ? "page" : undefined}
                      onClick={() => {
                        setTab(key);
                        setSearch("");
                        setFilter("all");
                        setQueue("all");
                        setSelected("");
                        setMobileListOpen(true);
                      }}
                    >
                      {label}
                      {operator && key === "inbox" && (
                        <span>
                          {
                            state.conversations.filter((c) => c.state !== "resolved" && c.unread)
                              .length
                          }
                        </span>
                      )}
                    </button>
                  ))}
                </nav>
              )}
              {operator && state.pendingConversions?.length > 0 && (
                <div className="pending-conversions" role="status">
                  {state.pendingConversions.map((p) => (
                    <button
                      key={p.conversationId}
                      onClick={() => {
                        chooseConversation(p.conversationId);
                        setTab("inbox");
                        setConvert(true);
                      }}
                    >
                      {p.title} ·{" "}
                      {p.state === "failed"
                        ? "建单未完成，修改后重试"
                        : "建单结果待确认，查看并重试"}
                    </button>
                  ))}
                </div>
              )}
              {(tab === "inbox" || tab === "ended") &&
                (operator ? (
                  <div
                    className={
                      "operator-workspace " +
                      (mobileListOpen ? "mobile-list-open" : "")
                    }
                  >
                    <section className="conversation-list">
                      <label className="search">
                        <Icon name="search" size={15} />
                        <input
                          aria-label="搜索咨询"
                          placeholder="搜索用户、应用或咨询"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </label>
                      <div className="queue-tabs">
                        {(tab === "ended"
                          ? [
                              ["all", "全部"],
                              ["mine", "我的"],
                            ]
                          : [
                              ["all", "全部"],
                              ["new", "待接待"],
                              ["mine", "我的"],
                            ]
                        ).map(([key, label]) => (
                          <button
                            aria-pressed={queue === key}
                            onClick={() => setQueue(key)}
                            key={key}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="conversation-scroll">
                        {list.map((c) => (
                          <button
                            className={
                              "conversation-row " +
                              (conversation.id === c.id ? "active " : "") + (c.unread ? "has-unread" : "")
                            }
                            onClick={() => chooseConversation(c.id)}
                            key={c.id}
                          >
                            <div className="row-top">
                              <Avatar small />
                              <strong>{c.name}</strong>
                              <time>{timeText(c.time)}</time>
                              {c.unread && <span className="unread-count" aria-label={(c.unreadMessageIds?.length || 1)+" 条未读"}>{Math.min(99,c.unreadMessageIds?.length || 1)}</span>}
                            </div>
                            <p>{c.latestSide === "operator" ? "回复：" : ""}{c.preview || c.title}</p>
                            <div className="row-bottom">
                              <Mark app={c.app} size={13} />
                              <span>{APPS[c.app].name}</span>
                              {c.ai?.mode === "ai" && <span className="ai-label">AI 接待</span>}
                              {c.state === "new" && c.ai?.mode !== "ai" && (
                                <span className="new-label">待接待</span>
                              )}
                            </div>
                          </button>
                        ))}
                        {!list.length && (
                          <div className="empty">
                            <p>
                              {tab === "ended"
                                ? "暂无已结束的咨询"
                                : "没有匹配的咨询"}
                            </p>
                          </div>
                        )}
                      </div>
                      <div className="list-footer">{list.length} 条咨询</div>
                    </section>
                    {conversation.id ? (
                      <>
                        <Chat
                          conversation={conversation}
                          operator={true}
                          state={state}
                          onSend={send}
                        onRetry={retryMessage}
                        onRead={acknowledgeRead}
                        onAiMode={changeAiMode}
                          onPreview={setPreview}
                          onTicket={openTicket}
                          notify={setToast}
                          onClaim={async () => {
                            try {
                              await mutation(
                                "/api/relay/conversations/" +
                                  conversation.id +
                                  "/claim",
                                {},
                              );
                              await refresh();
                            } catch (e) {
                              setToast(e.message);
                              await refresh();
                            }
                          }}
                          onResolve={resolve}
                          onShowList={() => setMobileListOpen(true)}
                          onShowContext={() => setContextOpen(true)}
                          ticketExists={Boolean(linked)}
                          onManageTicket={() =>
                            linked ? openTicket(linked.id) : setConvert(true)
                          }
                        />
                        <ContextPanel
                          canConvert={
                            conversation.receptionist?.id === state.profile?.id
                          }
                          conversation={conversation}
                          ticket={linked}
                          onConvert={() => setConvert(true)}
                          onTicket={openTicket}
                          onSource={() => setSource(true)}
                          onReply={sendReply}
                        />
                      </>
                    ) : (
                      <section className="operator-empty empty">
                        <Icon name="message-circle" size={32} />
                        <p>
                          {tab === "ended"
                            ? "暂无已结束的咨询"
                            : "暂无待处理的咨询"}
                        </p>
                        <button
                          className="button mobile-back"
                          onClick={() => setMobileListOpen(true)}
                        >
                          查看列表
                        </button>
                      </section>
                    )}
                  </div>
                ) : (
                  <div className="customer-workspace">
                    <Chat
                      conversation={conversation}
                      operator={false}
                      onBegin={beginAgain}
                      state={state}
                      onSend={send}
                        onRetry={retryMessage}
                        onRead={acknowledgeRead}
                        onAiMode={changeAiMode}
                      onPreview={setPreview}
                      notify={setToast}
                    />
                  </div>
                ))}
              {operator && tab === "tickets" && ticketContent}
            </>
          ))}
      </main>
      {mobileNavigationOpen && (
        <MobileDialog className="mobile-navigation" title="CoBuild 导航" onClose={() => setMobileNavigationOpen(false)}>
          <Sidebar operator={operator} profile={state.profile} connected={connected}
            requiresLogin={loadError?.action === "login"} collapsed={false} mobile
            onCollapse={() => setMobileNavigationOpen(false)} />
        </MobileDialog>
      )}
      {contextOpen && conversation.id && (
        <MobileDialog className="modal context-dialog" title="咨询详情" onClose={() => setContextOpen(false)}>
          <header><h2>咨询详情</h2><button className="icon-button" aria-label="关闭咨询详情" onClick={() => setContextOpen(false)}><Icon name="x" /></button></header>
          <ContextPanel canConvert={conversation.receptionist?.id === state.profile?.id}
            conversation={conversation} ticket={linked}
            onConvert={() => { setContextOpen(false); setConvert(true); }}
            onTicket={openTicket} onSource={() => { setContextOpen(false); setSource(true); }} onReply={sendReply} />
        </MobileDialog>
      )}
      {convert && (
        <ConvertDialog
          conversation={conversation}
          onClose={() => setConvert(false)}
          onCreate={convertTicket}
        />
      )}
      {preview && (
        <PreviewDialog item={preview} onClose={() => setPreview(null)} />
      )}
      {source && (
        <dialog open className="source-dialog">
          <header>
            <h2>咨询来源</h2>
            <button
              className="icon-button"
              aria-label="关闭来源信息"
              onClick={() => setSource(false)}
            >
              <Icon name="x" />
            </button>
          </header>
          <div className="modal-body">
            <div className="source-chip">
              <Mark app={conversation.app} />
              {APPS[conversation.app].name}
            </div>
            <h3>{conversation.title}</h3>
          </div>
        </dialog>
      )}
      {toast && (
        <div className="toast" role="status">
          <Icon name="circle-check" size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}
