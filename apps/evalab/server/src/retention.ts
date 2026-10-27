import type { PoolClient } from 'pg';
import type { AppContext } from './context.js';
import { insertAudit } from './audit.js';
import { withTx } from './db.js';
import { displayManifest, type MaterialPayload } from './materials.js';

export async function purgeReleasedHistory(ctx: AppContext): Promise<number> {
  const rows = await ctx.pool.query<{ enrollment_id: string; materials_id: string | null }>(
    `SELECT e.id AS enrollment_id, m.id AS materials_id
     FROM enrollments e
     LEFT JOIN reviews r ON r.enrollment_id = e.id
     LEFT JOIN materials m ON m.enrollment_id = e.id AND m.purged_at IS NULL
     WHERE (
         (r.published_at IS NOT NULL AND r.published_at < clock_timestamp() - interval '90 days')
         OR ((r.published_at IS NULL) AND e.deadline IS NOT NULL AND e.deadline < clock_timestamp() - interval '90 days')
       )
       AND (
         m.id IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM material_approvals ap
           WHERE ap.enrollment_id = e.id
             AND (
               coalesce(ap.manifest->>'projectSummary', '') <> ''
               OR coalesce(ap.manifest->>'collaborationSummary', '') <> ''
             )
         )
       )
     LIMIT 50`,
  );
  let count = 0;
  for (const row of rows.rows) {
    const purged = await withTx(ctx.pool, async (client) => purgeOne(client, row.enrollment_id, row.materials_id));
    if (purged) count += 1;
  }
  return count;
}

async function purgeOne(client: PoolClient, enrollmentId: string, materialsId: string | null): Promise<boolean> {
  let changed = false;
  if (materialsId) {
    const locked = await client.query<{ enrollment_id: string; payload: MaterialPayload | null; repo_sha: string; purged_at: Date | null }>(
      'SELECT enrollment_id, payload, repo_sha, purged_at FROM materials WHERE id = $1 FOR UPDATE',
      [materialsId],
    );
    const row = locked.rows[0];
    if (row && !row.purged_at) {
      const manifest = row.payload ? (row.payload.manifest ?? displayManifest(null)) : { files: [], clients: [], projectSummary: '', collaborationSummary: '' };
      const payload = {
        schemaVersion: 1,
        repoSha: row.repo_sha,
        purged: true,
        manifest: { ...manifest, projectSummary: '', collaborationSummary: '' },
        files: (row.payload?.files ?? []).map((file) => ({ name: file.name, content: '' })),
      };
      await client.query('UPDATE materials SET payload = $2::jsonb, purged_at = clock_timestamp() WHERE id = $1', [materialsId, JSON.stringify(payload)]);
      changed = true;
    }
  }
  const cleared = await client.query(
    `UPDATE material_approvals
     SET manifest = jsonb_set(
       jsonb_set(manifest, '{projectSummary}', '""'::jsonb, true),
       '{collaborationSummary}', '""'::jsonb, true
     )
     WHERE enrollment_id = $1
       AND (
         coalesce(manifest->>'projectSummary', '') <> ''
         OR coalesce(manifest->>'collaborationSummary', '') <> ''
       )`,
    [enrollmentId],
  );
  if ((cleared.rowCount ?? 0) > 0) changed = true;
  if (!changed) return false;
  await insertAudit(client, {
    actorId: null,
    actorName: 'system',
    action: 'PURGE_HISTORY',
    enrollmentId,
    details: materialsId ? { materialsId } : {},
  });
  return true;
}
