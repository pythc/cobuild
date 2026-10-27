import { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('feishuIdentities')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('provider', 'varchar(32)', (c) => c.notNull())
    .addColumn('appId', 'varchar(128)', (c) => c.notNull())
    .addColumn('tenantKey', 'varchar(128)', (c) => c.notNull())
    .addColumn('subject', 'varchar(256)', (c) => c.notNull())
    .addColumn('unionId', 'varchar(256)')
    .addColumn('userId', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('workspaceId', 'uuid', (c) =>
      c.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addUniqueConstraint('feishu_identity_subject_unique', [
      'appId',
      'tenantKey',
      'subject',
    ])
    .addUniqueConstraint('feishu_identity_user_unique', [
      'userId',
      'workspaceId',
    ])
    .execute();
}
export async function down(db: Kysely<any>): Promise<void> {
  const row = await db
    .selectFrom('feishuIdentities')
    .select('id')
    .limit(1)
    .executeTakeFirst();
  if (row)
    throw new Error(
      'Feishu identities exist. Restore the documented snapshot to roll back this migration without losing identity bindings.',
    );
  await db.schema.dropTable('feishuIdentities').execute();
}
