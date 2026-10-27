// Read state comes only from an acknowledged, visible public message. AI
// context ingestion and internal notes must never advance either read cursor.
export function messageStatus(store, row, message, view) {
  if (message.private || message.message_type === 2) return undefined;
  const outgoing = view === 'operator' ? message.message_type === 1 : message.message_type === 0;
  if (!outgoing) return undefined;
  const read = view === 'operator'
    ? store.replyCursor(row.id).read_id
    : store.db.prepare('SELECT MAX(read_id) AS id FROM operator_reads WHERE conversation_id=?').get(row.id)?.id || 0;
  if (Number(message.id) <= read) return 'read';
  const epoch = view === 'operator' ? store.unreadEpoch() : store.attention.epoch();
  return Number(message.created_at) * 1000 >= epoch ? 'unread' : 'sent';
}

export async function mapLimit(values, limit, action) {
  const result = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, values.length)}, async () => {
    while (next < values.length) {
      const index = next++;
      result[index] = await action(values[index], index);
    }
  }));
  return result;
}
