import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('feishuIdentities')
    .addColumn('directoryStatus', 'varchar(32)', (c) =>
      c.notNull().defaultTo('unknown'),
    )
    .addColumn('directoryCheckedAt', 'timestamptz')
    .addColumn('lastEventAt', 'timestamptz')
    .execute();
  await db.schema
    .createTable('feishuSyncRuns')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('appId', 'varchar(128)', (c) => c.notNull())
    .addColumn('tenantKey', 'varchar(128)', (c) => c.notNull())
    .addColumn('startedAt', 'timestamptz', (c) => c.notNull())
    .addColumn('finishedAt', 'timestamptz')
    .addColumn('status', 'varchar(32)', (c) => c.notNull())
    .addColumn('source', 'varchar(32)', (c) => c.notNull())
    .addColumn('total', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('added', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('updated', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('blocked', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('errorCode', 'varchar(64)')
    .execute();
  await db.schema
    .createTable('feishuEvents')
    .addColumn('eventId', 'varchar(256)', (c) => c.primaryKey())
    .addColumn('receivedAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createTable('feishuNotificationOutbox')
    .addColumn('notificationId', 'uuid', (c) =>
      c.primaryKey().references('notifications.id').onDelete('cascade'),
    )
    .addColumn('state', 'varchar(32)', (c) => c.notNull().defaultTo('pending'))
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('createdAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('nextAttemptAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('claimedAt', 'timestamptz')
    .addColumn('finishedAt', 'timestamptz')
    .addColumn('messageId', 'varchar(256)')
    .addColumn('errorCode', 'varchar(64)')
    .execute();
  await db.schema
    .createIndex('feishu_outbox_pending')
    .on('feishuNotificationOutbox')
    .columns(['state', 'nextAttemptAt'])
    .execute();
}

export async function down(db: Kysely<any>) {
  // Lifecycle denial must not disappear simply by changing images. Restore the
  // pre-upgrade snapshot while stopped, or keep these additive tables on rollback.
  const used = await db
    .selectFrom('feishuSyncRuns')
    .select('id')
    .limit(1)
    .executeTakeFirst();
  if (used)
    throw new Error(
      'Directory sync has run; restore the documented snapshot to roll back safely.',
    );
  await db.schema.dropTable('feishuNotificationOutbox').execute();
  await db.schema.dropTable('feishuEvents').execute();
  await db.schema.dropTable('feishuSyncRuns').execute();
  await db.schema
    .alterTable('feishuIdentities')
    .dropColumn('directoryStatus')
    .dropColumn('directoryCheckedAt')
    .dropColumn('lastEventAt')
    .execute();
}
