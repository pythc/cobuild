import { Kysely, sql } from 'kysely';
export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('pages')
    .addColumn('nodeType', 'varchar(16)', (c) => c.notNull().defaultTo('page'))
    .addColumn('fileExtension', 'varchar(16)')
    .execute();
  await sql`alter table pages add constraint pages_node_type_check check (node_type in ('page','folder','file','office'))`.execute(
    db,
  );
  await db.schema
    .createTable('officeFileVersions')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('pageId', 'uuid', (c) =>
      c.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('storagePath', 'text', (c) => c.notNull())
    .addColumn('fileName', 'text', (c) => c.notNull())
    .addColumn('mimeType', 'text', (c) => c.notNull())
    .addColumn('size', 'integer', (c) => c.notNull())
    .addColumn('sha256', 'text', (c) => c.notNull())
    .addColumn('createdById', 'uuid', (c) =>
      c.references('users.id').onDelete('set null'),
    )
    .addColumn('createdAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('office_file_version_unique', ['pageId', 'version'])
    .execute();
  await db.schema
    .createTable('officeSessions')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('pageId', 'uuid', (c) =>
      c.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('users', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('expiresAt', 'timestamptz', (c) => c.notNull())
    .addColumn('saveAcks', 'jsonb', (c) =>
      c.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn('closedAt', 'timestamptz')
    .execute();
  await db.schema
    .createTable('officeTasks')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('pageId', 'uuid', (c) =>
      c.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('userId', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('sourceVersion', 'integer', (c) => c.notNull())
    .addColumn('format', 'varchar(16)', (c) => c.notNull())
    .addColumn('purpose', 'varchar(16)', (c) => c.notNull())
    .addColumn('state', 'varchar(16)', (c) => c.notNull().defaultTo('queued'))
    .addColumn('result', 'jsonb')
    .addColumn('error', 'text')
    .addColumn('createdAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updatedAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createTable('officeStorageGc')
    .addColumn('storagePath', 'text', (c) => c.primaryKey())
    .execute();
  await sql`create function office_enqueue_file_gc() returns trigger language plpgsql as $$ begin
    insert into office_storage_gc(storage_path) values (old.storage_path) on conflict do nothing; return old;
  end $$`.execute(db);
  await sql`create trigger office_file_gc after delete on office_file_versions for each row execute function office_enqueue_file_gc()`.execute(
    db,
  );
  await sql`create function office_enqueue_task_gc() returns trigger language plpgsql as $$ begin
    if old.result->>'sourcePath' is not null then insert into office_storage_gc(storage_path) values (old.result->>'sourcePath') on conflict do nothing; end if;
    if old.result->>'storagePath' is not null then insert into office_storage_gc(storage_path) values (old.result->>'storagePath') on conflict do nothing; end if; return old;
  end $$`.execute(db);
  await sql`create trigger office_task_gc after delete on office_tasks for each row execute function office_enqueue_task_gc()`.execute(
    db,
  );
  await db.schema
    .createIndex('office_tasks_pending')
    .on('officeTasks')
    .columns(['state', 'createdAt'])
    .execute();
}
export async function down(db: Kysely<any>) {
  // A rollback must not silently discard files created by the new version.
  const count = await db
    .selectFrom('pages')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('nodeType', '!=', 'page')
    .executeTakeFirst();
  if (count.n)
    throw new Error(
      '存在文件或文件夹，请先备份并迁移这些节点后再回滚 Office 迁移',
    );
  await db.schema.dropTable('officeTasks').execute();
  await sql`drop function office_enqueue_task_gc()`.execute(db);
  await db.schema.dropTable('officeSessions').execute();
  await db.schema.dropTable('officeFileVersions').execute();
  await sql`drop function office_enqueue_file_gc()`.execute(db);
  await db.schema.dropTable('officeStorageGc').execute();
  await sql`alter table pages drop constraint pages_node_type_check`.execute(
    db,
  );
  await db.schema
    .alterTable('pages')
    .dropColumn('fileExtension')
    .dropColumn('nodeType')
    .execute();
}
