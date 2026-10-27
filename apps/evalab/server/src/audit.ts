import type { PoolClient } from 'pg';
import { redactDetails } from './security.js';

export async function insertAudit(
  client: PoolClient,
  event: {
    actorId: string | null;
    actorName: string;
    action: string;
    enrollmentId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (actor_id, actor_name, action, enrollment_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      event.actorId,
      event.actorName.slice(0, 80),
      event.action,
      event.enrollmentId ?? null,
      JSON.stringify(redactDetails(event.details ?? {})),
    ],
  );
}
