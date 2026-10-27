export function cleanRelayMessage(
  m: any,
  id: string,
  view: "operator" | "customer",
) {
  return {
    id: String(m.id),
    clientId: m.content_attributes?.relay_client_id,
    ai: m.content_attributes?.relay_ai === true,
    side:
      m.message_type === 0
        ? "customer"
        : m.message_type === 2
          ? "system"
          : "operator",
    senderName:
      view === "customer"
        ? m.message_type === 0
          ? "我"
          : "小助手"
        : m.content_attributes?.relay_sender_name || m.sender?.name || "",
    content: typeof m.content === "string" ? m.content : "",
    time: new Date(Number(m.created_at) * 1000).toISOString(),
    private: !!m.private,
    attachments: (m.attachments || []).map((f: any) => ({
      id: String(f.id),
      name: relayFilename(f),
      kind: f.file_type === "image" ? "image" : "text",
      size:
        typeof f.file_size === "number"
          ? Math.ceil(f.file_size / 1024) + " KB"
          : "",
      url: `/api/relay/attachments/${id}/${f.id}?view=${view}`,
    })),
  };
}
export function relayFilename(f: any) {
  try {
    return decodeURIComponent(
      new URL(f.data_url).pathname.split("/").at(-1) || "附件",
    );
  } catch {
    return "附件";
  }
}
