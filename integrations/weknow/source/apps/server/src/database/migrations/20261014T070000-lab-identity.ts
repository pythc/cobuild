import { Kysely, sql } from 'kysely';
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('labIdentitySessions')
    .addColumn('sessionId', 'uuid', (c) =>
      c.primaryKey().references('userSessions.id').onDelete('cascade'),
    )
    .addColumn('subject', 'text', (c) => c.notNull())
    .addColumn('sealedGrant', 'text', (c) => c.notNull())
    .addColumn('expiresAt', 'timestamptz', (c) => c.notNull())
    .execute();
}
export async function down(db: Kysely<any>) {
  const row = await db
    .selectFrom('labIdentitySessions')
    .select(sql<number>`count(*)`.as('n'))
    .executeTakeFirst();
  if (Number(row?.n) > 0)
    throw new Error('Revoke unified identity sessions before rollback');
  await db.schema.dropTable('labIdentitySessions').execute();
}
