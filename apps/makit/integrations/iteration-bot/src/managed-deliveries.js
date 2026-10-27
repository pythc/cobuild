// Optional managed workflow consumer. The default legacy mode never claims this queue.
// All authentication belongs to a dedicated machine identity, not a human MCP key.
export function createManagedDeliveryConsumer({ config, sendCard, sendPost, fetchImpl = fetch, log }) {
  let running = false;
  const enabled = () => process.env.WORKFLOW_DELIVERY_OWNER === 'managed_bot';

  function endpoint(path) {
    const url = new URL(process.env.WORKFLOW_DELIVERY_API_URL || '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Managed delivery URL must be an HTTPS application endpoint');
    return `${url.toString().replace(/\/$/, '')}/${path}`;
  }

  async function request(path, body) {
    const machineToken = process.env.WORKFLOW_DELIVERY_WORKER_TOKEN || '';
    if (machineToken.length < 32) throw new Error('Dedicated workflow worker identity is not configured');
    const response = await fetchImpl(endpoint(path), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Workflow-Worker-Token': machineToken,
        ...(process.env.WORKFLOW_DELIVERY_OPENAPI_KEY ? { Authorization: `Bearer ${process.env.WORKFLOW_DELIVERY_OPENAPI_KEY}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Managed delivery API rejected request (${response.status})`);
    return response.json();
  }

  function receipt(response) {
    const envelope = response?.response;
    const data = envelope?.data || envelope?.result || envelope;
    const messageId = data?.message_id || data?.data?.message_id;
    return typeof messageId === 'string' && /^om_[A-Za-z0-9_-]+$/.test(messageId) ? messageId : '';
  }

  async function runOnce() {
    if (!enabled() || running) return { processed: 0 };
    if (config.identities?.messages !== 'bot') throw new Error('Managed deliveries require bot identity');
    running = true;
    try {
      const result = await request('claim', {});
      const items = result?.items || result?.data?.items || [];
      if (!Array.isArray(items) || items.length > 20) throw new Error('Invalid managed delivery batch');
      let processed = 0;
      for (const item of items) {
        const ack = { id: item.id, leaseToken: item.leaseToken, outcome: 'unknown', errorCode: 'message_transport_ambiguous' };
        try {
          const group = item.channel === 'feishu_group';
          if ((!group && item.payload?.receiveIdType !== 'open_id') ||
            (group && item.payload?.receiveIdType !== 'chat_id') ||
            !/^[a-z0-9-]{36}$/i.test(item.id) || item.idempotencyKey !== item.id) throw new Error('Invalid managed delivery envelope');
          const target = group ? { chatId: item.targetId } : { userId: item.targetId };
          const context = { purpose: 'workflow', source: 'managed_deliveries' };
          const response = item.payload.type === 'interactive'
            ? await sendCard(target, item.payload.content, item.idempotencyKey, context)
            : item.payload.type === 'post' ? await sendPost(target, item.payload.content, item.idempotencyKey, context) : null;
          if (response?.blocked) {
            ack.outcome = 'suppressed'; ack.errorCode = response.safetyBlocked ? 'local_safety_guard' : 'local_policy_denied';
          } else {
            const messageId = receipt(response);
            if (messageId) { ack.outcome = 'sent'; ack.messageId = messageId; delete ack.errorCode; }
            else ack.errorCode = 'missing_message_receipt';
          }
        } catch (error) {
          // Only structured Feishu rejection evidence is safe to retry. CLI/network errors stay unknown.
          for (const text of [error?.stdout, error?.stderr]) {
            try {
              const failure = JSON.parse(text || '{}');
              const code = Number(failure?.error?.code ?? failure?.code);
              if (Number.isInteger(code) && code > 0 && failure?.ok === false) {
                ack.outcome = 'rejected'; ack.errorCode = `feishu_rejected_${code}`;
              }
            } catch { /* Do not print CLI arguments, payload, stdout or credentials. */ }
          }
        }
        // If ack fails, stop this batch; a lease expiry is classified unknown by the server.
        // No automatic repeat of an already attempted send, even after a process restart.
        const accepted = await request('result', ack);
        if (!(accepted?.accepted || accepted?.data?.accepted)) throw new Error('Managed delivery receipt was not accepted');
        processed += 1;
      }
      return { processed };
    } finally { running = false; }
  }
  async function ingest(input) {
    if (!enabled()) throw new Error('Managed delivery ingestion is disabled');
    const envelope = await request('ingest', input);
    const result = envelope?.id ? envelope : envelope?.data;
    if (!result?.id) throw new Error('Workflow event was not durably accepted');
    return { ok: true, delivered: result.state === 'sent', queued: ['pending','sending','retry_wait'].includes(result.state),
      blocked: ['shadow','suppressed'].includes(result.state), state: result.state, deliveryId: result.id };
  }
  async function reconcile(requirementId, previousMarker, currentMarker) {
    if (!enabled()) throw new Error('Managed source requires managed bot ownership');
    const response = await request('reconcile', { requirementId, previousMarker, currentMarker });
    const result = response?.sourceVersion ? response : response?.data;
    if (result?.sourceVersion !== 'confirmed_operations_v1' || !Array.isArray(result.edges))
      throw new Error('Managed workflow source handshake failed');
    return result.edges;
  }
  return { enabled, runOnce, ingest, reconcile };
}
