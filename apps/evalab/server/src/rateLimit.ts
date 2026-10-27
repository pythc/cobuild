import type { Pool, PoolClient } from 'pg';
import type { AppContext } from './context.js';
import { HttpError } from './errors.js';
import { blindKey } from './security.js';

type Queryable = Pool | PoolClient;

export async function assertRateLimit(
  ctx: AppContext,
  db: Queryable,
  bucket: string,
  subject: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const blinded = blindKey(ctx.config.sessionSecret, `${bucket}:${subject}`);
  const result = await db.query<{ count: number }>(
    `INSERT INTO rate_limits (bucket, subject, window_start, count)
     VALUES ($1, $2, to_timestamp(floor(extract(epoch FROM now()) / $3) * $3), 1)
     ON CONFLICT (bucket, subject, window_start)
     DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [bucket, blinded, windowSeconds],
  );
  const count = result.rows[0]?.count ?? 0;
  if (count > limit) {
    throw new HttpError(429, '操作过于频繁，请稍后再试', 'RATE_LIMITED');
  }
}

export async function enqueueMail(
  db: Queryable,
  mail: { to: string; subject: string; body: string; idempotencyKey: string },
): Promise<void> {
  await db.query(
    `INSERT INTO email_outbox (to_email, subject, body, status, idempotency_key)
     VALUES ($1, $2, $3, 'PENDING', $4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [mail.to, mail.subject, mail.body, mail.idempotencyKey],
  );
}
