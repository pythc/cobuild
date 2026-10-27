import {createHash} from 'node:crypto';

export function aiContext(row, profile, messages, appName) {
  const publicMessages = messages.filter(m => !m.private && m.message_type !== 2 && !m.content_attributes?.deleted);
  const history = publicMessages.slice(-40).map(m => ({
    role: m.message_type === 0 ? 'user' : 'assistant',
    content: String(m.content || '').slice(0, 4000),
    attachments: (m.attachments || []).map(f => ({name: f.file_name || '附件', type: f.file_type})),
  }));
  // No session grants, private notes, attachment URLs or other users' messages.
  let truncated=publicMessages.length>40;
  while(Buffer.byteLength(JSON.stringify(history))>60000 && history.length>1){history.shift();truncated=true;}
  return {user: {name: profile.name || '用户', account: profile.account}, sourceApp: appName || row.app,
    scope:{principal:row.principal,app:row.app},conversationId: row.id, history, historyTruncated:truncated};
}

export class AiReception {
  constructor({store, chat, config, request = fetch}) {
    this.store = store; this.db = store.db; this.chat = chat; this.config = config || {};
    this.request = request; this.enabled = config?.enabled === true;
    this.gates = new Map(); this.aborts = new Map(); this.tasks = new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS ai_reception(
      conversation_id TEXT PRIMARY KEY, mode TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
      cursor INTEGER NOT NULL DEFAULT 0, trigger_id INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'idle', profile_json TEXT NOT NULL DEFAULT '{}',
      answer_json TEXT, marker TEXT, retry_at INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO ai_reception(conversation_id,mode)
        SELECT id,'human' FROM conversations;
      UPDATE ai_reception SET state='idle' WHERE state='generating';
      UPDATE ai_reception SET state='unknown' WHERE state='sending';
      UPDATE ai_reception SET profile_json=(SELECT json_object('name',a.customer_name) FROM consultations a WHERE a.conversation_id=ai_reception.conversation_id)
        WHERE profile_json='{}' AND EXISTS(SELECT 1 FROM consultations a WHERE a.conversation_id=ai_reception.conversation_id);`);
    if (this.enabled) {
      const url = new URL(config.endpoint);
      if (!['http://127.0.0.1:18504','http://127.0.0.1:18506'].includes(url.origin) || url.pathname !== '/reply' || !config.key || config.key.length < 32)
        throw Error('Invalid Relay harness configuration');
    }
  }
  register(row, profile) {
    this.db.prepare("INSERT INTO ai_reception(conversation_id,mode,profile_json) VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET profile_json=CASE WHEN ai_reception.profile_json='{}' THEN excluded.profile_json ELSE ai_reception.profile_json END")
      .run(row.id, this.enabled ? 'ai' : 'human', JSON.stringify(profile));
  }
  status(id) {
    const s = this.db.prepare('SELECT mode,state,generation FROM ai_reception WHERE conversation_id=?').get(id);
    return {available: this.enabled, mode: s?.mode || 'human', state: s?.state || 'idle'};
  }
  async withGate(id, fn) {
    const previous = this.gates.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(fn);
    this.gates.set(id, task);
    try { return await task; } finally { if (this.gates.get(id) === task) this.gates.delete(id); }
  }
  human(id) {
    this.aborts.get(id)?.abort();
    this.db.prepare("UPDATE ai_reception SET mode='human',generation=generation+1,state=CASE WHEN state IN ('unknown','sending') THEN 'unknown' ELSE 'idle' END WHERE conversation_id=?").run(id);
  }
  async resume(row) {
    const messages = await this.chat.messages(row.remote_id);
    const lastReply = Math.max(0, ...messages.filter(m => m.message_type === 1 && !m.private).map(m => m.id));
    const name = this.db.prepare('SELECT customer_name FROM consultations WHERE conversation_id=?').get(row.id)?.customer_name || '用户';
    this.register(row, {name, account: row.principal});
    const pending = this.db.prepare('SELECT state FROM ai_reception WHERE conversation_id=?').get(row.id);
    if (['unknown','sending'].includes(pending?.state)) throw Object.assign(Error('上一条 AI 回复结果尚待核对，请稍后重试'), {status:409});
    this.db.prepare("UPDATE ai_reception SET mode='ai',generation=generation+1,cursor=?,state='idle',retry_at=0 WHERE conversation_id=?").run(lastReply,row.id);
    this.wake();
  }
  start() { if (this.enabled) { this.timer = setInterval(() => this.wake(), 3000); this.timer.unref(); this.wake(); } }
  wake() {
    if (!this.enabled || this.stopped || this.scanning) return;
    this.scanning = this.scan().catch(() => {}).finally(() => {this.scanning = null;});
  }
  async scan() {
    const rows = this.db.prepare(`SELECT c.*,s.mode,s.state,s.generation,s.cursor,s.trigger_id,s.profile_json,s.answer_json,s.marker
      FROM ai_reception s JOIN conversations c ON c.id=s.conversation_id
      WHERE (s.mode='ai' OR s.state='unknown') AND s.retry_at<=? ORDER BY s.retry_at,c.rowid LIMIT 200`).all(Date.now());
    for (const row of rows) {
      if (this.stopped || this.tasks.size >= 2) break;
      if (this.aborts.has(row.id)) continue;
      const abort = new AbortController(); this.aborts.set(row.id, abort);
      const task = this.run(row, abort.signal).catch(error => this.failed(row,error))
        .finally(() => {this.aborts.delete(row.id); this.tasks.delete(task);});
      this.tasks.add(task);
    }
  }
  failed(row, error) {
    if(this.stopped){
      this.db.prepare("UPDATE ai_reception SET state=CASE WHEN state IN ('sending','unknown') THEN 'unknown' ELSE 'idle' END,retry_at=0 WHERE conversation_id=? AND generation=?").run(row.id,row.generation);
      return;
    }
    // A failed reconciliation GET says nothing about a previous uncertain POST.
    // Preserve that marker through outages and takeover; only a known rejected
    // POST can retire a sending attempt without later reconciliation.
    const rejected = error?.rejected === true ? 1 : 0;
    this.db.prepare(`UPDATE ai_reception
      SET mode=CASE WHEN state='unknown' OR (state='sending' AND ?=0) THEN mode ELSE 'human' END,
          state=CASE WHEN state='unknown' OR (state='sending' AND ?=0) THEN 'unknown' ELSE 'error' END,
          retry_at=? WHERE conversation_id=? AND generation=?`)
      .run(rejected,rejected,Date.now()+15000,row.id,row.generation);
  }
  current(row) {
    const s = this.db.prepare('SELECT * FROM ai_reception WHERE conversation_id=?').get(row.id);
    return s && (s.mode === 'ai' || s.state === 'unknown') && s.generation === row.generation ? s : null;
  }
  async run(row, signal) {
    let remote = await this.chat.request(this.chat.account(`/conversations/${row.remote_id}`));
    if (remote.inbox_id !== this.chat.config().apps[row.app]?.inboxId) throw Error('Inbox changed');
    let messages = await this.chat.messages(row.remote_id);
    let s = this.current(row); if (!s) return;
    if (['unknown','sending'].includes(s.state)) {
      const found = messages.find(m => m.content_attributes?.relay_ai_marker === s.marker);
      if (found) this.db.prepare("UPDATE ai_reception SET cursor=MAX(cursor,trigger_id),state='done',retry_at=0 WHERE conversation_id=? AND generation=?").run(row.id,row.generation);
      else this.db.prepare('UPDATE ai_reception SET retry_at=? WHERE conversation_id=?').run(Date.now()+15000,row.id);
      return;
    }
    if (remote.status === 'resolved') {this.human(row.id); return;}
    const latest = messages.filter(m => m.message_type === 0 && !m.private && !m.content_attributes?.deleted).at(-1);
    if (!latest || latest.id <= s.cursor) {
      this.db.prepare('UPDATE ai_reception SET retry_at=? WHERE conversation_id=? AND generation=?').run(Date.now()+4000,row.id,row.generation); return;
    }
    let answer;
    if (s.state === 'prepared' && s.trigger_id === latest.id) answer = JSON.parse(s.answer_json);
    else {
      this.db.prepare("UPDATE ai_reception SET state='generating',trigger_id=? WHERE conversation_id=? AND generation=?").run(latest.id,row.id,row.generation);
      const context = aiContext(row, JSON.parse(s.profile_json), messages, this.chat.config().apps[row.app].name);
      const response = await this.request(this.config.endpoint, {method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(145000)]),
        headers:{'Content-Type':'application/json','X-Relay-AI-Key':this.config.key},body:JSON.stringify(context)});
      if (!response.ok) throw Error('Harness unavailable');
      const text = await response.text(); if (Buffer.byteLength(text)>16000) throw Error('Harness response limit');
      answer = JSON.parse(text);
      if (typeof answer.answer !== 'string' || !answer.answer.trim() || answer.answer.length > 3000 || typeof answer.handoff !== 'boolean') throw Error('Invalid harness answer');
      signal.throwIfAborted();
      if (!this.current(row)) return;
      const marker = createHash('sha256').update(`relay-ai:${row.id}:${row.generation}:${latest.id}`).digest('hex');
      this.db.prepare("UPDATE ai_reception SET state='prepared',answer_json=?,marker=? WHERE conversation_id=? AND generation=?")
        .run(JSON.stringify(answer),marker,row.id,row.generation);
    }
    await this.withGate(row.id, async () => {
      signal.throwIfAborted(); s = this.current(row); if (!s) return;
      this.chat.invalidate?.();
      remote = await this.chat.request(this.chat.account(`/conversations/${row.remote_id}`));
      messages = await this.chat.messages(row.remote_id);
      const newest = messages.filter(m => m.message_type === 0 && !m.private && !m.content_attributes?.deleted).at(-1);
      if (remote.status === 'resolved') { this.human(row.id); return; }
      const laterHumanReply = messages.some(m=>m.message_type===1 && !m.private && !m.content_attributes?.relay_ai && m.id>s.trigger_id);
      if(laterHumanReply){this.human(row.id);return;}
      if (newest?.id !== s.trigger_id) {
        this.db.prepare("UPDATE ai_reception SET state='idle',retry_at=0 WHERE conversation_id=? AND generation=?").run(row.id,row.generation); return;
      }
      if (!this.current(row)) return;
      this.db.prepare("UPDATE ai_reception SET state='sending' WHERE conversation_id=? AND generation=?").run(row.id,row.generation);
      const result = await this.chat.request(this.chat.account(`/conversations/${row.remote_id}/messages`), {method:'POST',body:{
        content:answer.answer, message_type:'outgoing', private:false,
        content_attributes:{relay_ai:true,relay_ai_handoff:answer.handoff,relay_ai_marker:s.marker,relay_sender_name:'小助手 · AI'},
      }});
      if (!Number.isSafeInteger(result.id)) throw Error('Unconfirmed AI send');
      if (!answer.handoff) this.store.attention.replied(row.id,result.id);
      this.db.prepare("UPDATE ai_reception SET cursor=trigger_id,state='done',mode=?,retry_at=0 WHERE conversation_id=? AND generation=?")
        .run(answer.handoff ? 'human' : 'ai',row.id,row.generation);
    });
  }
  async stop() {this.stopped=true;clearInterval(this.timer);for (const abort of this.aborts.values()) abort.abort();await this.scanning;await Promise.allSettled([...this.tasks]);}
}
