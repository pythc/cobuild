import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { createPool, migrate } from './db.js';
import { loadConfig } from './config.js';
import { deliverOutbox } from './workers.js';
import { enqueueMail } from './rateLimit.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('expired verification mail is removed without dropping password-reset or ordinary pending mail', { skip: !databaseUrl && 'requires PostgreSQL' }, async () => {
  const schema = `mail_queue_${process.pid}`;
  const loaded = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, DB_SCHEMA: schema, SESSION_SECRET: 'local-mail-queue-secret-only-123456' });
  const pool = createPool(databaseUrl!, schema);
  try {
    await migrate(pool, schema);
    const code = await pool.query<{ id: string }>(`INSERT INTO email_challenges(email,purpose,code_hash,expires_at)
      VALUES ('expired@example.test','REGISTER','unused',clock_timestamp()-interval '1 minute') RETURNING id`);
    await enqueueMail(pool, { to: 'expired@example.test', subject: 'expired', body: 'expired code', idempotencyKey: `register-code:${code.rows[0]!.id}` });
    const live = await pool.query<{ id: string }>(`INSERT INTO email_challenges(email,purpose,code_hash,expires_at)
      VALUES ('reset@example.test','RESET','unused',clock_timestamp()+interval '5 minutes') RETURNING id`);
    await enqueueMail(pool, { to: 'reset@example.test', subject: 'reset', body: 'live code', idempotencyKey: `email-code:${live.rows[0]!.id}` });
    await enqueueMail(pool, { to: 'result@example.test', subject: 'result', body: 'result released', idempotencyKey: 'result:one' });
    await deliverOutbox({ pool, config: loaded.config });
    const rows = (await pool.query<{subject:string;status:string;body:string}>('SELECT subject,status,body FROM email_outbox ORDER BY subject')).rows;
    assert.deepEqual(rows, [
      {subject:'expired',status:'FAILED',body:''},
      {subject:'reset',status:'PENDING',body:'live code'},
      {subject:'result',status:'PENDING',body:'result released'},
    ]);
  } finally {
    await pool.end();
    const cleanup = new Pool({connectionString:databaseUrl});
    try { await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await cleanup.end(); }
  }
});
