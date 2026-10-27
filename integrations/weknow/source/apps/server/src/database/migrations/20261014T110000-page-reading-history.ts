import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>) {
  await db.schema.createTable('pageReadingHistory')
    .addColumn('userId', 'uuid', c => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('pageId', 'uuid', c => c.notNull().references('pages.id').onDelete('cascade'))
    .addColumn('workspaceId', 'uuid', c => c.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('lastReadAt', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('page_reading_history_pkey', ['userId', 'pageId'])
    .execute();
  await db.schema.createIndex('page_reading_history_user_time')
    .on('pageReadingHistory').columns(['userId', 'lastReadAt']).execute();
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('pageReadingHistory').execute();
}
