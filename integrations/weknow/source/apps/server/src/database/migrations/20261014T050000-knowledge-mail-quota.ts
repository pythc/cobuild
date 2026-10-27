import { Kysely } from 'kysely';
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('knowledgeMailQuota')
    .addColumn('key', 'varchar(100)', (c) => c.primaryKey())
    .addColumn('count', 'integer', (c) => c.notNull())
    .execute();
}
export async function down(db: Kysely<any>) {
  await db.schema.dropTable('knowledgeMailQuota').execute();
}
