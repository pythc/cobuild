import {createHash,randomUUID} from 'node:crypto';
import {publicReply} from './unread.mjs';
const key=(...v)=>createHash('sha256').update(v.join(':')).digest('hex').slice(0,32);
const incoming=m=>(m.message_type===0||m.message_type==='incoming')&&m.private===false&&m.status!=='failed'&&!m.content_attributes?.deleted&&((typeof m.content==='string'&&m.content.trim())||m.attachments?.length);
export class AttentionStore {
  constructor(store,{now=Date.now}={}) {
    this.store=store;this.db=store.db;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS attention_epoch(id INTEGER PRIMARY KEY CHECK(id=1),started_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attention_state(conversation_id TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0,response_id INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'open',status_revision INTEGER NOT NULL DEFAULT 0,next_check INTEGER NOT NULL DEFAULT 0,card_hash TEXT,card_attempt_hash TEXT,card_attempts INTEGER NOT NULL DEFAULT 0,card_retry_at INTEGER NOT NULL DEFAULT 0,card_error TEXT);
      CREATE TABLE IF NOT EXISTS incoming_receipts(conversation_id TEXT NOT NULL,message_id INTEGER NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(conversation_id,message_id));
      CREATE TABLE IF NOT EXISTS operator_reads(conversation_id TEXT NOT NULL,employee_id TEXT NOT NULL,read_id INTEGER NOT NULL,PRIMARY KEY(conversation_id,employee_id));
      CREATE TABLE IF NOT EXISTS relay_alerts(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,kind TEXT NOT NULL,cycle INTEGER NOT NULL,recipient TEXT NOT NULL,through_id INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,first_attempt INTEGER,message_id TEXT,error_code TEXT,payload_json TEXT);
      CREATE INDEX IF NOT EXISTS relay_alerts_due ON relay_alerts(state,due);
    `);
    this.db.prepare('INSERT OR IGNORE INTO attention_epoch VALUES(1,?)').run(Math.floor(now()/1000)*1000);
  }
  ensure(id){this.db.prepare('INSERT OR IGNORE INTO attention_state(conversation_id) VALUES(?)').run(id);}
  epoch(){return this.db.prepare('SELECT started_at FROM attention_epoch WHERE id=1').get().started_at;}
  state(id){this.ensure(id);return this.db.prepare('SELECT * FROM attention_state WHERE conversation_id=?').get(id);}
  summary(id){
    const state=this.state(id),reception=this.db.prepare('SELECT * FROM reception WHERE conversation_id=?').get(id),pending=this.db.prepare('SELECT MIN(message_id) AS id,MIN(received_at) AS since,MAX(message_id) AS latest,COUNT(*) AS count FROM incoming_receipts WHERE conversation_id=? AND message_id>?').get(id,state.response_id);
    return {...state,owner:reception?{id:reception.employee_id,name:reception.name}:null,pending:pending.id?pending:null};
  }
  ingest(id,messages,scanned=0){
    this.store.transaction(()=>{
      this.ensure(id);
      for(const m of messages){
        if(!Number.isSafeInteger(m.id)||m.id<1||m.id>2147483647)throw Error('Invalid message ID');
        const at=Number(m.created_at)*1000;
        if(!Number.isFinite(at)||at<=0||at>this.now()+60000)throw Error('Invalid message time');
        if(incoming(m)&&at>=this.epoch())this.db.prepare('INSERT OR IGNORE INTO incoming_receipts VALUES(?,?,?)').run(id,m.id,at);
        if(publicReply(m)&&!m.content_attributes?.relay_ai_handoff)this.db.prepare('UPDATE attention_state SET response_id=MAX(response_id,?) WHERE conversation_id=?').run(m.id,id);
      }
      this.db.prepare('UPDATE attention_state SET cursor=MAX(cursor,?) WHERE conversation_id=?').run(scanned,id);
    });
  }
  replied(id,messageId){this.ensure(id);this.db.prepare('UPDATE attention_state SET response_id=MAX(response_id,?) WHERE conversation_id=?').run(Number(messageId),id);}
  status(id,status,revision){this.ensure(id);const resolved=status==='resolved';this.db.prepare('UPDATE attention_state SET status=?,status_revision=status_revision+1,next_check=? WHERE conversation_id=?'+(revision===undefined?'':' AND status_revision=?')).run(resolved?'resolved':'open',this.now()+(resolved?60000:5000),id,...(revision===undefined?[]:[revision]));}
  unread(id,employee){return this.db.prepare('SELECT message_id FROM incoming_receipts WHERE conversation_id=? AND message_id>COALESCE((SELECT read_id FROM operator_reads WHERE conversation_id=? AND employee_id=?),0) ORDER BY message_id').all(id,id,employee).map(r=>String(r.message_id));}
  read(id,employee,messageId){if(!this.db.prepare('SELECT 1 FROM incoming_receipts WHERE conversation_id=? AND message_id=?').get(id,messageId))throw Object.assign(Error('消息尚未同步，请稍后重试'),{status:409});this.db.prepare('INSERT INTO operator_reads VALUES(?,?,?) ON CONFLICT(conversation_id,employee_id) DO UPDATE SET read_id=MAX(read_id,excluded.read_id)').run(id,employee,messageId);return {readThrough:String(messageId)};}
  rows(){return this.db.prepare('SELECT c.* FROM conversations c JOIN consultations a ON a.conversation_id=c.id LEFT JOIN attention_state s ON s.conversation_id=c.id WHERE a.first_message_id IS NOT NULL AND COALESCE(s.next_check,0)<=? ORDER BY COALESCE(s.next_check,0),c.rowid LIMIT 20').all(this.now());}
  defer(id){this.ensure(id);this.db.prepare('UPDATE attention_state SET next_check=? WHERE conversation_id=?').run(this.now()+10000,id);}
  enqueue(id,kind,cycle,recipient,due,through=0){this.db.prepare('INSERT OR IGNORE INTO relay_alerts(id,conversation_id,kind,cycle,recipient,due,through_id) VALUES(?,?,?,?,?,?,?)').run(key(id,kind,cycle,recipient),id,kind,cycle,recipient,due,through);}
  plan(id,{unclaimedMs=300000,unansweredMs=600000,mergeMs=30000}={}){
    const s=this.summary(id);if(s.status==='resolved'||!s.pending)return;
    const p=s.pending;
    if(!s.owner)this.enqueue(id,'unclaimed',p.id,'group',p.since+unclaimedMs);
    this.enqueue(id,'overdue-group',p.id,'group',p.since+unansweredMs);
    if(s.owner){
      this.enqueue(id,'overdue-dm',p.id,s.owner.id,p.since+unansweredMs);
      const sent=this.db.prepare("SELECT MAX(through_id) AS id FROM relay_alerts WHERE conversation_id=? AND recipient=? AND kind='message' AND state IN ('sent','unknown','sending','pending')").get(id,s.owner.id).id||0;
      const read=this.db.prepare('SELECT read_id FROM operator_reads WHERE conversation_id=? AND employee_id=?').get(id,s.owner.id)?.read_id||0;
      const first=this.db.prepare('SELECT MIN(message_id) AS id,MIN(received_at) AS at FROM incoming_receipts WHERE conversation_id=? AND message_id>?').get(id,Math.max(sent,read,s.response_id));
      if(first.id&&!this.db.prepare("SELECT 1 FROM relay_alerts WHERE conversation_id=? AND recipient=? AND kind='message' AND state IN ('pending','sending')").get(id,s.owner.id))this.enqueue(id,'message',first.id,s.owner.id,first.at+mergeMs,first.id);
    }
  }
  valid(item){const s=this.summary(item.conversation_id);if(s.status==='resolved'||!s.pending)return false;
    if(item.kind==='message')return s.owner?.id===item.recipient&&this.unread(item.conversation_id,item.recipient).some(id=>Number(id)>s.response_id);
    if(s.pending.id!==item.cycle)return false;
    if(item.kind==='unclaimed')return !s.owner;
    return item.recipient==='group'||s.owner?.id===item.recipient;
  }
  next(){return this.store.transaction(()=>{
    const now=this.now();
    // Feishu deduplicates a stable UUID for one hour. Retry uncertain sends only
    // inside a conservative 50 minute window; never replay after that boundary.
    this.db.prepare("UPDATE relay_alerts SET state=CASE WHEN first_attempt>? THEN 'pending' ELSE 'unknown' END,due=? WHERE state='sending' AND lease_until<?").run(now-3000000,now,now);
    for(let n=0;n<50;n++){
      const item=this.db.prepare("SELECT * FROM relay_alerts WHERE state='pending' AND due<=? ORDER BY due,rowid LIMIT 1").get(now);if(!item)return null;
      if(item.first_attempt!==null&&now-item.first_attempt>=3000000){this.db.prepare("UPDATE relay_alerts SET state='unknown' WHERE id=?").run(item.id);continue;}
      if(!this.valid(item)){this.db.prepare("UPDATE relay_alerts SET state='cancelled' WHERE id=?").run(item.id);continue;}
      const lease=randomUUID(),s=this.summary(item.conversation_id),through=item.kind==='message'&&!item.first_attempt?s.pending.latest:item.through_id;
      this.db.prepare("UPDATE relay_alerts SET state='sending',attempts=attempts+1,lease=?,lease_until=?,first_attempt=COALESCE(first_attempt,?),through_id=? WHERE id=?").run(lease,now+60000,now,through,item.id);
      return {...item,attempts:item.attempts+1,lease,through_id:through,first_attempt:item.first_attempt||now};
    }return null;
  });}
  deferDelivery(item) {
    this.db.prepare("UPDATE relay_alerts SET state='pending',attempts=MAX(0,attempts-1),first_attempt=CASE WHEN payload_json IS NULL THEN NULL ELSE first_attempt END,due=? WHERE id=? AND lease=? AND state='sending'").run(this.now()+30000,item.id,item.lease);
  }
  freeze(item,payload){
    if(item.payload_json)return JSON.parse(item.payload_json);
    const content=JSON.stringify(payload);
    if(!this.db.prepare("UPDATE relay_alerts SET payload_json=? WHERE id=? AND lease=? AND state='sending' AND lease_until>?").run(content,item.id,item.lease,this.now()).changes)throw Error('Alert lease expired');
    return payload;
  }
  finish(item,outcome,messageId,errorCode){
    const retry=!['sent','cancelled'].includes(outcome)&&item.attempts<8&&this.now()-item.first_attempt<3000000;
    return this.db.prepare("UPDATE relay_alerts SET state=?,message_id=?,error_code=?,due=? WHERE id=? AND lease=? AND state='sending' AND lease_until>?").run(outcome==='sent'?'sent':retry?'pending':outcome,messageId||null,String(errorCode||'').slice(0,40),this.now()+Math.min(300000,15000*2**Math.min(item.attempts,4)),item.id,item.lease,this.now()).changes===1;
  }
}
export class AttentionTracker {
  constructor(chat,attention){this.chat=chat;this.attention=attention;this.inflight=new Map();this.checked=new Map();}
  async sync(row,{force=false}={}){
    if(this.inflight.has(row.id))return this.inflight.get(row.id);
    if(!force&&(this.checked.get(row.id)||0)>Date.now()-4000)return;
    const work=this.scan(row);this.inflight.set(row.id,work);
    try{await work;this.checked.set(row.id,Date.now());}finally{this.inflight.delete(row.id);}
  }
  async scan(row){
    const a=this.attention,s=a.state(row.id),config=this.chat.config().apps[row.app];if(!config)return;
    const remote=await this.chat.request(this.chat.account(`/conversations/${row.remote_id}`));
    if(remote.inbox_id!==config.inboxId)throw Error('Inconsistent consultation inbox');
    let messages=[],cursor=s.cursor;
    if(cursor){
      for(let i=0;i<100;i++){
        const v=await this.chat.request(this.chat.account(`/conversations/${row.remote_id}/messages`)+`?after=${cursor}`);
        if(!Array.isArray(v.payload))throw Error('Invalid incoming messages');
        const batch=v.payload;
        if(batch.some(m=>!Number.isSafeInteger(m.id)||m.id<=cursor))throw Error('Invalid message pagination');
        messages.push(...batch);cursor=Math.max(cursor,...batch.map(m=>m.id));
        if(batch.length<100)break;if(i===99)throw Error('Message catch-up incomplete');
      }
    }else{
      let before=0;
      for(let i=0;i<100;i++){
        const v=await this.chat.request(this.chat.account(`/conversations/${row.remote_id}/messages`)+(before?`?before=${before}`:''));
        if(!Array.isArray(v.payload))throw Error('Invalid incoming messages');const batch=v.payload;
        if(batch.some(m=>!Number.isSafeInteger(m.id)||m.id<1||!Number.isFinite(Number(m.created_at))))throw Error('Invalid message pagination');
        messages.push(...batch);cursor=Math.max(cursor,...batch.map(m=>m.id));
        if(batch.length<20||batch.some(m=>Number(m.created_at)*1000<a.epoch()))break;
        const next=Math.min(...batch.map(m=>m.id));if(before&&next>=before)throw Error('Message pagination did not advance');before=next;
        if(i===99)throw Error('Message catch-up incomplete');
      }
    }
    a.ingest(row.id,messages,cursor);a.status(row.id,remote.status,s.status_revision);
  }
}
