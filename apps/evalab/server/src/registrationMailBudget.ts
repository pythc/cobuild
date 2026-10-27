import type { PoolClient } from 'pg';
import type { AppConfig } from './config.js';

/** Caller holds the registration mail queue advisory lock until enqueue commits. */
export async function registrationMailBudgetRetry(
  client: PoolClient,
  config: AppConfig,
  email: string,
): Promise<number> {
  const result = await client.query<{ retry: number | null }>(
    `WITH limits(capacity, seconds, recipient) AS (
       VALUES ($1::int, 3600, NULL::text), ($2::int, 86400, NULL::text),
              (3, 3600, $3::text), (10, 86400, $3::text)
     )
     SELECT max(ceil(extract(epoch FROM (last_slot.created_at + limits.seconds * interval '1 second' - clock_timestamp()))))::int AS retry
     FROM limits
     CROSS JOIN LATERAL (
       SELECT o.created_at FROM email_outbox o
       WHERE o.idempotency_key LIKE 'register-code:%'
         AND o.created_at > clock_timestamp() - limits.seconds * interval '1 second'
         AND (limits.recipient IS NULL OR o.to_email = limits.recipient)
       ORDER BY o.created_at DESC
       OFFSET (limits.capacity - 1) LIMIT 1
     ) last_slot`,
    [config.registrationMailHourlyBudget, config.registrationMailDailyBudget, email],
  );
  return Math.max(0, result.rows[0]?.retry ?? 0);
}
