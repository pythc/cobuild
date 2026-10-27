import { Kysely, sql } from 'kysely';
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('documentSuggestions')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('pageId', 'uuid', (c) =>
      c.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('creatorId', 'uuid', (c) =>
      c.references('users.id').onDelete('set null'),
    )
    .addColumn('original', 'text', (c) => c.notNull())
    .addColumn('replacement', 'text', (c) => c.notNull())
    .addColumn('selection', 'jsonb', (c) => c.notNull())
    .addColumn('fingerprint', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
    .addColumn('resolvedById', 'uuid', (c) =>
      c.references('users.id').onDelete('set null'),
    )
    .addColumn('createdAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('resolvedAt', 'timestamptz')
    .execute();
  await db.schema
    .createIndex('document_suggestions_page')
    .on('documentSuggestions')
    .columns(['pageId', 'createdAt'])
    .execute();
  await db.schema
    .createTable('documentFileIndex')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('pageId', 'uuid', (c) =>
      c.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('sourceVersion', 'text', (c) => c.notNull())
    .addColumn('fileName', 'text', (c) => c.notNull())
    .addColumn('text', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
    .addColumn('error', 'text')
    .addColumn('indexedAt', 'timestamptz')
    .execute();
  await db.schema
    .createIndex('document_file_index_page')
    .on('documentFileIndex')
    .column('pageId')
    .execute();
}
export async function down(db: Kysely<any>) {
  const row = await db
    .selectFrom('documentSuggestions')
    .select(sql<number>`count(*)::int`.as('n'))
    .executeTakeFirst();
  if (row?.n)
    throw new Error(
      'Review records exist; roll back the application without deleting user review data',
    );
  await db.schema.dropTable('documentFileIndex').execute();
  await db.schema.dropTable('documentSuggestions').execute();
}
