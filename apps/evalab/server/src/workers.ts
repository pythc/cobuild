import { purgeDeletedMaterialFiles } from './adminDeletion.js';
import nodemailer from 'nodemailer';
import type { AppContext } from './context.js';
import { purgeUploadFiles } from './uploads.js';
import { purgeOAuthCredentials } from './oauth.js';
import { purgeReleasedHistory } from './retention.js';
import { purgeRegistrationProtection } from './registrationProtection.js';

export function startWorkers(ctx: AppContext): () => void {
  const mail = setInterval(() => {
    void deliverOutbox(ctx).catch((err: unknown) => {
      console.error(JSON.stringify({ component: 'mail', name: err instanceof Error ? err.name : 'Error' }));
    });
  }, 15_000);
  const retention = setInterval(() => {
    void Promise.all([purgeReleasedHistory(ctx).then(() => purgeUploadFiles(ctx)), purgeOAuthCredentials(ctx), purgeRegistrationProtection(ctx)]).catch((err: unknown) => {
      console.error(JSON.stringify({ component: 'retention', name: err instanceof Error ? err.name : 'Error' }));
    });
  }, 60 * 60 * 1000);
  const uploads = setInterval(() => {
    void Promise.all([purgeUploadFiles(ctx), purgeDeletedMaterialFiles(ctx)]).catch(() => console.error(JSON.stringify({component:'upload-cleanup',event:'retry-needed'})));
  }, 60_000);
  uploads.unref();
  mail.unref();
  retention.unref();
  void deliverOutbox(ctx).catch(() => undefined);
  void purgeDeletedMaterialFiles(ctx).catch(() => console.error(JSON.stringify({component:'deleted-file-cleanup',event:'retry-needed'})));
  void Promise.all([purgeReleasedHistory(ctx).then(() => purgeUploadFiles(ctx)), purgeOAuthCredentials(ctx), purgeRegistrationProtection(ctx)]).catch(() => undefined);
  return () => {
    clearInterval(mail);
    clearInterval(retention);
    clearInterval(uploads);
  };
}

export async function deliverOutbox(ctx: AppContext): Promise<void> {
  if (ctx.config.nodeEnv === 'production' && ctx.config.mailTestSink) {
    throw new Error('MAIL_TEST_SINK is refused in production');
  }
  await ctx.pool.query(
    `UPDATE email_outbox SET status = 'PENDING'
     WHERE status = 'SENDING' AND next_attempt_at <= now()`,
  );
  // Do not deliver expired verification codes after a queue backlog or outage.
  await ctx.pool.query(
    `UPDATE email_outbox o SET status = 'FAILED', body = '', last_error = 'verification-expired'
     WHERE o.status = 'PENDING' AND EXISTS (
       SELECT 1 FROM email_challenges c
       WHERE o.idempotency_key IN ('email-code:' || c.id::text, 'register-code:' || c.id::text)
         AND (c.expires_at <= clock_timestamp() OR c.consumed_at IS NOT NULL)
     )`,
  );
  if (ctx.config.mailTestSink) {
    await ctx.pool.query(
      `UPDATE email_outbox SET status = 'SENT', sent_at = now(), body = '' WHERE status = 'PENDING'`,
    );
    return;
  }
  if (!ctx.config.smtp) return;
  const client = await ctx.pool.connect();
  let claimed: Array<{ id: string; to_email: string; subject: string; body: string; attempts: number }> = [];
  try {
    await client.query('BEGIN');
    const rows = await client.query<{ id: string; to_email: string; subject: string; body: string; attempts: number }>(
      `SELECT id, to_email, subject, body, attempts
       FROM email_outbox
       WHERE status = 'PENDING' AND next_attempt_at <= now()
       ORDER BY CASE
         WHEN EXISTS (SELECT 1 FROM email_challenges c WHERE email_outbox.idempotency_key = 'email-code:' || c.id::text AND c.purpose = 'RESET') THEN 0
         WHEN idempotency_key LIKE 'email-code:%' OR idempotency_key LIKE 'register-code:%' THEN 2
         ELSE 1 END, created_at
       LIMIT 5
       FOR UPDATE SKIP LOCKED`,
    );
    claimed = rows.rows;
    for (const row of claimed) {
      await client.query(
        `UPDATE email_outbox SET status = 'SENDING', attempts = attempts + 1, next_attempt_at = now() + interval '10 minutes' WHERE id = $1`,
        [row.id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const smtp = ctx.config.smtp;
  const transport = nodemailer.createTransport({
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
  });
  for (const row of claimed) {
    try {
      await transport.sendMail({ from: smtp.from, to: row.to_email, subject: row.subject, text: row.body });
      await ctx.pool.query(
        `UPDATE email_outbox SET status = 'SENT', sent_at = now(), body = '', last_error = NULL WHERE id = $1`,
        [row.id],
      );
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = error instanceof Error ? error.name : 'send-failed';
      if (attempts >= 8) {
        await ctx.pool.query(`UPDATE email_outbox SET status = 'FAILED', last_error = $2 WHERE id = $1`, [row.id, message.slice(0, 200)]);
      } else {
        await ctx.pool.query(
          `UPDATE email_outbox SET status = 'PENDING', last_error = $2, next_attempt_at = now() + ($3::int * interval '1 minute') WHERE id = $1`,
          [row.id, message.slice(0, 200), attempts * attempts],
        );
      }
    }
  }
}
