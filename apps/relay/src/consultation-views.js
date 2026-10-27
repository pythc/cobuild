export function filterConversations(rows,{queue='all',employeeId='',search='',appName=()=>''}={}) {
  return rows.filter(c=>
    (queue==='all'||queue==='mine'&&c.receptionist?.id===employeeId||queue==='new'&&c.state==='new')&&
    (c.name+c.title+(c.preview||'')+appName(c.app)).includes(search)
  );
}

export function conversationBucket(conversations, operator, tab) {
  if (!operator || tab === "tickets") return conversations;
  return conversations.filter(
    (c) => (c.state === "resolved") === (tab === "ended"),
  );
}

export function selectedConversation(conversations, selected) {
  return (
    conversations.find((c) => c.id === selected) || conversations[0] || null
  );
}

export function messageSender(message, conversation, operator) {
  if (!operator) return message.side === "customer" ? "我" : "小助手";
  if (message.private) return "内部备注";
  return message.side === "customer"
    ? conversation.name
    : message.senderName || conversation.owner || "客服";
}
