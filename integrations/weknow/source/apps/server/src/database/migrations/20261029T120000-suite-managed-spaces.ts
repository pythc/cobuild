import { Kysely, sql } from 'kysely';
export async function up(db: Kysely<any>) {
  await db.schema.createTable('suiteManagedSpaces')
    .addColumn('spaceId','uuid',c=>c.primaryKey().references('spaces.id').onDelete('cascade'))
    .addColumn('projectId','uuid',c=>c.notNull().unique())
    .addColumn('organizationId','text',c=>c.notNull()).execute();
  await db.schema.createTable('suiteManagedAccess')
    .addColumn('spaceId','uuid',c=>c.notNull().references('suiteManagedSpaces.spaceId').onDelete('cascade'))
    .addColumn('userId','uuid',c=>c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('expiresAt','timestamptz',c=>c.notNull())
    .addPrimaryKeyConstraint('suite_managed_access_pk',['spaceId','userId']).execute();
  // No backfill: existing project mappings retain their legacy shared ACLs.
}
export async function down(_db: Kysely<any>) {
  throw new Error('Managed access is a security boundary; use a forward repair, never drop it on rollback');
}
