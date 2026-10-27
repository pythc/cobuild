export const deliveryText = state => ({sending:'发送中',unread:'未读',read:'已读',sent:'已发送',failed:'发送失败',unknown:'结果待确认'})[state] || '';
export function mergeOutbox(conversations, outbox) {
  return conversations.map(c => {
    const pending = outbox.filter(m => m.conversationId === c.id && !c.messages.some(v => v.clientId === m.clientId || v.id === m.remoteId));
    const messages = [...c.messages, ...pending].sort((a,b) => Date.parse(a.time)-Date.parse(b.time) || Number(a.id)-Number(b.id));
    const latest = messages.filter(m => !m.private && m.side !== 'system').at(-1);
    return {...c,messages,...(latest ? {preview:latest.content || '[附件]',latestSide:latest.side,time:latest.time} : {})};
  }).sort((a,b) => Date.parse(b.time)-Date.parse(a.time));
}
export function pruneOutbox(outbox, conversations) {
  return outbox.filter(m => !conversations.find(c=>c.id===m.conversationId)?.messages.some(v=>v.clientId===m.clientId || v.id===m.remoteId));
}
