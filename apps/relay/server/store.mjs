import { AttentionStore } from "./attention.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
const digest = (v) => createHash("sha256").update(v).digest("hex");
const conflict = (message) =>
  Object.assign(new Error(message), { status: 409 });
export class RelayStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ds = lstatSync(directory);
    if (!ds.isDirectory() || ds.isSymbolicLink())
      throw Error("Unsafe Relay storage");
    chmodSync(directory, 0o700);
    const filename = join(directory, "relay.sqlite");
    try {
      const st = lstatSync(filename);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)
        throw Error("Unsafe Relay database");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS contacts(principal TEXT,app TEXT,source_id TEXT,contact_id INTEGER,PRIMARY KEY(principal,app));
  CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,principal TEXT,app TEXT,remote_id INTEGER,source_id TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(app,remote_id));
  CREATE TABLE IF NOT EXISTS operations(marker TEXT PRIMARY KEY,payload_hash TEXT,state TEXT,lease_token TEXT,lease_expires_at INTEGER,response_json TEXT,updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS reception(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),employee_id TEXT NOT NULL,name TEXT NOT NULL,claimed_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,conversation_id TEXT UNIQUE REFERENCES conversations(id),app TEXT,name TEXT,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,available_at INTEGER NOT NULL DEFAULT 0,lease_expires_at INTEGER NOT NULL DEFAULT 0,message_id TEXT);
  CREATE TABLE IF NOT EXISTS consultations(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),customer_name TEXT NOT NULL,first_message_id TEXT,started_at TEXT,next_check_at INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS consultations_pending ON consultations(first_message_id,next_check_at);
  INSERT OR IGNORE INTO consultations(conversation_id,customer_name) SELECT c.id,COALESCE(n.name,'用户') FROM conversations c LEFT JOIN notices n ON n.conversation_id=c.id;
  CREATE TABLE IF NOT EXISTS intents(conversation_id TEXT PRIMARY KEY,marker TEXT UNIQUE,document TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(id_hash TEXT PRIMARY KEY,encrypted TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS handoffs(code_hash TEXT PRIMARY KEY,challenge TEXT NOT NULL,encrypted TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS unread_epoch(id INTEGER PRIMARY KEY CHECK(id=1),started_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS reply_cursors(conversation_id TEXT PRIMARY KEY,scanned_id INTEGER NOT NULL DEFAULT 0,read_id INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS reply_receipts(conversation_id TEXT NOT NULL,message_id INTEGER NOT NULL,PRIMARY KEY(conversation_id,message_id));
  CREATE TABLE IF NOT EXISTS flows(state TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,encrypted TEXT NOT NULL,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);`);
    this.db
      .prepare("INSERT OR IGNORE INTO unread_epoch VALUES(1,?)")
      .run(Date.now());
    const noticeColumns = new Set(this.db.prepare('PRAGMA table_info(notices)').all().map(r => r.name));
    if (!noticeColumns.has('first_attempt')) this.db.exec('ALTER TABLE notices ADD COLUMN first_attempt INTEGER');
    if (!noticeColumns.has('payload_json')) this.db.exec('ALTER TABLE notices ADD COLUMN payload_json TEXT');
    this.attention = new AttentionStore(this);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async contacts(p, a) {
    return this.db
      .prepare("SELECT * FROM contacts WHERE principal=? AND app=?")
      .get(p, a);
  }
  async saveContact(p, a, s, id) {
    this.db
      .prepare(
        "INSERT INTO contacts VALUES(?,?,?,?) ON CONFLICT(principal,app) DO UPDATE SET source_id=excluded.source_id,contact_id=excluded.contact_id",
      )
      .run(p, a, s, id);
  }
  async conversation(id) {
    return this.db
      .prepare(
        "SELECT c.*,a.started_at FROM conversations c LEFT JOIN consultations a ON a.conversation_id=c.id WHERE c.id=?",
      )
      .get(id);
  }
  async conversations(p) {
    return p
      ? this.db
          .prepare(
            "SELECT c.*,a.started_at FROM conversations c LEFT JOIN consultations a ON a.conversation_id=c.id WHERE c.principal=? ORDER BY julianday(c.created_at) DESC,c.id DESC LIMIT 201",
          )
          .all(p)
      : this.db
          .prepare(
            "SELECT c.*,a.started_at FROM conversations c JOIN consultations a ON a.conversation_id=c.id WHERE a.first_message_id IS NOT NULL ORDER BY julianday(a.started_at) DESC, c.id DESC LIMIT 201",
          )
          .all();
  }
  unreadEpoch() {
    return this.db
      .prepare("SELECT started_at FROM unread_epoch WHERE id=1")
      .get().started_at;
  }
  replyCursor(id) {
    return (
      this.db
        .prepare("SELECT * FROM reply_cursors WHERE conversation_id=?")
        .get(id) || { scanned_id: 0, read_id: 0 }
    );
  }
  saveReplies(id, scanned, replies) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO reply_cursors(conversation_id) VALUES(?)",
        )
        .run(id);
      for (const messageId of replies)
        this.db
          .prepare("INSERT OR IGNORE INTO reply_receipts VALUES(?,?)")
          .run(id, messageId);
      this.db
        .prepare(
          "UPDATE reply_cursors SET scanned_id=MAX(scanned_id,?) WHERE conversation_id=?",
        )
        .run(scanned, id);
    });
  }
  unreadReplies(id) {
    return this.db
      .prepare(
        "SELECT message_id FROM reply_receipts WHERE conversation_id=? AND message_id>COALESCE((SELECT read_id FROM reply_cursors WHERE conversation_id=?),0) ORDER BY message_id",
      )
      .all(id, id)
      .map((v) => String(v.message_id));
  }
  readReplies(id, messageId) {
    return this.transaction(() => {
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM reply_receipts WHERE conversation_id=? AND message_id=?",
          )
          .get(id, messageId)
      )
        throw Object.assign(Error("消息尚未同步，请稍后重试"), { status: 409 });
      this.db
        .prepare(
          "UPDATE reply_cursors SET read_id=MAX(read_id,?) WHERE conversation_id=?",
        )
        .run(messageId, id);
      return { readThrough: String(this.replyCursor(id).read_id) };
    });
  }
  async reserve(marker, payload_hash) {
    return this.transaction(() => {
      const now = Date.now(),
        lease = randomUUID();
      this.db
        .prepare(
          "INSERT OR IGNORE INTO operations VALUES(?,?,'preparing',?,?,NULL,?)",
        )
        .run(marker, payload_hash, lease, now + 60000, now);
      let row = this.db
        .prepare("SELECT * FROM operations WHERE marker=?")
        .get(marker);
      if (row.payload_hash !== payload_hash)
        throw conflict("同一请求不能修改内容");
      if (row.lease_token === lease) return { row, claimed: true };
      if (
        row.state === "failed" ||
        (row.state === "preparing" && row.lease_expires_at < now)
      ) {
        this.db
          .prepare(
            "UPDATE operations SET state='preparing',lease_token=?,lease_expires_at=?,updated_at=? WHERE marker=?",
          )
          .run(lease, now + 60000, now, marker);
        row = this.db
          .prepare("SELECT * FROM operations WHERE marker=?")
          .get(marker);
        return { row, claimed: true };
      }
      return { row, claimed: false };
    });
  }
  async writing(row) {
    const r = this.db
      .prepare(
        "UPDATE operations SET state='writing',updated_at=? WHERE marker=? AND lease_token=? AND state='preparing' AND lease_expires_at>?",
      )
      .run(Date.now(), row.marker, row.lease_token, Date.now());
    if (!r.changes) throw conflict("请求已失效，请重新查询");
  }
  async done(row, result) {
    const r = this.db
      .prepare(
        "UPDATE operations SET state='done',response_json=?,updated_at=? WHERE marker=? AND lease_token=? AND state IN ('preparing','writing','unknown','done')",
      )
      .run(JSON.stringify(result), Date.now(), row.marker, row.lease_token);
    if (!r.changes) throw conflict("操作回执写入失败，请重新查询");
  }
  async fail(row, rejected) {
    this.db
      .prepare(
        "UPDATE operations SET state=?,updated_at=? WHERE marker=? AND lease_token=? AND state<>'done'",
      )
      .run(
        rejected ? "failed" : "unknown",
        Date.now(),
        row.marker,
        row.lease_token,
      );
  }
  async get(id) {
    const v = this.db
      .prepare("SELECT * FROM reception WHERE conversation_id=?")
      .get(id);
    return v
      ? { id: v.employee_id, name: v.name, claimedAt: v.claimed_at }
      : null;
  }
  async claim(id, person, previous) {
    return this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO reception VALUES(?,?,?,?)")
        .run(id, person.id, person.name, person.claimedAt);
      if (previous)
        this.db
          .prepare(
            "UPDATE reception SET employee_id=?,name=?,claimed_at=? WHERE conversation_id=? AND employee_id=?",
          )
          .run(person.id, person.name, person.claimedAt, id, previous);
      const v = this.db
        .prepare("SELECT * FROM reception WHERE conversation_id=?")
        .get(id);
      return { id: v.employee_id, name: v.name, claimedAt: v.claimed_at };
    });
  }
  async register(row, name) {
    this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO conversations VALUES(?,?,?,?,?,?)")
        .run(
          row.id,
          row.principal,
          row.app,
          row.remote_id,
          row.source_id,
          row.created_at,
        );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO consultations(conversation_id,customer_name) VALUES(?,?)",
        )
        .run(row.id, name);
    });
  }
  async suppressEmptyNotice(id) {
    this.db
      .prepare(
        "UPDATE notices SET state='obsolete' WHERE conversation_id=? AND EXISTS(SELECT 1 FROM consultations WHERE conversation_id=? AND first_message_id IS NULL)",
      )
      .run(id, id);
  }
  async activate(id, messageId, receivedAt, notify = true) {
    if (!/^[1-9]\d*$/.test(String(messageId)))
      throw Error("Invalid message receipt");
    const startedAt = new Date(receivedAt).toISOString();
    if (
      this.db
        .prepare(
          "SELECT first_message_id FROM consultations WHERE conversation_id=?",
        )
        .get(id)?.first_message_id
    )
      return;
    this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT c.app,a.customer_name FROM conversations c JOIN consultations a ON a.conversation_id=c.id WHERE c.id=?",
        )
        .get(id);
      if (!row) throw Error("Unknown consultation");
      this.db
        .prepare(
          "UPDATE consultations SET first_message_id=?,started_at=? WHERE conversation_id=? AND first_message_id IS NULL",
        )
        .run(String(messageId), startedAt, id);
      if (!notify) return;
      // An old release notified on window-open. Retire that false alert and use
      // a fresh delivery key for the first real message, without replaying it.
      this.db
        .prepare(
          "UPDATE notices SET id=?,state='pending',attempts=0,lease=NULL,available_at=0,lease_expires_at=0,message_id=NULL,payload_json=NULL,first_attempt=NULL WHERE conversation_id=? AND state='obsolete'",
        )
        .run(digest("relay-notice-v2:" + id), id);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO notices(id,conversation_id,app,name) VALUES(?,?,?,?)",
        )
        .run(digest("relay-notice-v1:" + id), id, row.app, row.customer_name);
    });
  }
  async pendingConsultations() {
    return this.transaction(() => {
      const now = Date.now();
      const rows = this.db
        .prepare(
          "SELECT c.* FROM conversations c JOIN consultations a ON a.conversation_id=c.id WHERE a.first_message_id IS NULL AND a.next_check_at<=? ORDER BY a.next_check_at,c.rowid LIMIT 5",
        )
        .all(now);
      for (const row of rows)
        this.db
          .prepare(
            "UPDATE consultations SET next_check_at=? WHERE conversation_id=?",
          )
          .run(now + 60000, row.id);
      return rows;
    });
  }
  async nextNotice() {
    return this.transaction(() => {
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE notices SET state='unknown' WHERE state='sending' AND lease_expires_at<?",
        )
        .run(now);
      this.db.prepare("UPDATE notices SET state='unknown' WHERE state IN ('pending','rejected') AND first_attempt IS NOT NULL AND first_attempt<=?").run(now-3000000);
      const n = this.db
        .prepare(
          "SELECT n.* FROM notices n JOIN consultations a ON a.conversation_id=n.conversation_id WHERE a.first_message_id IS NOT NULL AND (n.state IN ('pending','rejected') OR (n.state='unknown' AND n.first_attempt>?)) AND n.available_at<=? AND n.attempts<8 ORDER BY n.rowid LIMIT 1",
        )
        .get(now-3000000,now);
      if (!n) return null;
      const lease = randomUUID();
      this.db
        .prepare(
          "UPDATE notices SET state='sending',attempts=attempts+1,lease=?,lease_expires_at=?,first_attempt=COALESCE(first_attempt,?) WHERE id=?",
        )
        .run(lease, now + 120000, now, n.id);
      return {
        id: n.id,
        conversationId: n.conversation_id,
        app: n.app,
        name: n.name,
        payload: n.payload_json ? JSON.parse(n.payload_json) : null,
        lease,
      };
    });
  }
  freezeNotice(item,payload) {
    if(item.payload)return item.payload;
    if(!this.db.prepare("UPDATE notices SET payload_json=? WHERE id=? AND lease=? AND state='sending' AND lease_expires_at>?").run(JSON.stringify(payload),item.id,item.lease,Date.now()).changes)throw Error('Notification lease expired');
    return payload;
  }
  async noticeResult(id, lease, outcome, messageId) {
    const r = this.db
      .prepare(
        "UPDATE notices SET state=?,message_id=?,available_at=? WHERE id=? AND lease=? AND state='sending' AND lease_expires_at>?",
      )
      .run(
        outcome,
        messageId || null,
        Date.now() + 60000,
        id,
        lease,
        Date.now(),
      );
    return { accepted: r.changes === 1 };
  }
  async read(_source, id) {
    const r = this.db
      .prepare("SELECT document FROM intents WHERE conversation_id=?")
      .get(id);
    return r ? JSON.parse(r.document) : null;
  }
  intentByRequirement(id) {
    return this.db
      .prepare(
        "SELECT document FROM intents WHERE json_extract(document,'$.requirement_id')=?",
      )
      .get(id);
  }
  saveIntent(v) {
    this.db
      .prepare(
        "INSERT INTO intents VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET document=excluded.document",
      )
      .run(v.conversation_id, v.marker, JSON.stringify(v));
  }
  close() {
    this.db.close();
  }
}
