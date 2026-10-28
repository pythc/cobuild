import { sql, RawBuilder } from 'kysely';
// Applied before pagination and counts, including native ACL grants from groups.
export function managedAccess(space: any, userId: string | RawBuilder<unknown>) {
  return sql<boolean>`(NOT EXISTS (SELECT 1 FROM suite_managed_spaces m WHERE m.space_id = ${space})
    OR EXISTS (SELECT 1 FROM suite_managed_access a WHERE a.space_id = ${space}
      AND a.user_id = ${userId}::uuid AND a.expires_at > clock_timestamp()))`;
}
export function unmanagedSpace(space: any) {
  return sql<boolean>`NOT EXISTS (SELECT 1 FROM suite_managed_spaces m WHERE m.space_id = ${space})`;
}
