import { Kysely, sql } from 'kysely';
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('knowledgeOAuthClients')
    .addColumn('clientId', 'uuid', (c) => c.primaryKey())
    .addColumn('metadata', 'jsonb', (c) => c.notNull())
    .addColumn('createdAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createTable('knowledgeOAuthRequests')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('clientId', 'uuid', (c) =>
      c.notNull().references('knowledgeOAuthClients.clientId'),
    )
    .addColumn('browserHash', 'varchar(64)', (c) => c.notNull())
    .addColumn('redirectUri', 'text', (c) => c.notNull())
    .addColumn('challenge', 'varchar(128)', (c) => c.notNull())
    .addColumn('state', 'text')
    .addColumn('scopes', 'jsonb', (c) => c.notNull())
    .addColumn('resource', 'text', (c) => c.notNull())
    .addColumn('expiresAt', 'timestamptz', (c) => c.notNull())
    .addColumn('resolvedAt', 'timestamptz')
    .addColumn('codeHash', 'varchar(64)', (c) => c.unique())
    .addColumn('codeExpiresAt', 'timestamptz')
    .addColumn('usedAt', 'timestamptz')
    .addColumn('userId', 'uuid')
    .addColumn('workspaceId', 'uuid')
    .addColumn('sessionId', 'uuid')
    .execute();
  await db.schema
    .createTable('knowledgeOAuthGrants')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('clientId', 'uuid', (c) =>
      c.notNull().references('knowledgeOAuthClients.clientId'),
    )
    .addColumn('userId', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('workspaceId', 'uuid', (c) =>
      c.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('sessionId', 'uuid', (c) =>
      c.notNull().references('userSessions.id').onDelete('cascade'),
    )
    .addColumn('resource', 'text', (c) => c.notNull())
    .addColumn('scopes', 'jsonb', (c) => c.notNull())
    .addColumn('createdAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('expiresAt', 'timestamptz', (c) => c.notNull())
    .addColumn('revokedAt', 'timestamptz')
    .execute();
  await db.schema
    .createTable('knowledgeOAuthTokens')
    .addColumn('tokenHash', 'varchar(64)', (c) => c.primaryKey())
    .addColumn('kind', 'varchar(10)', (c) => c.notNull())
    .addColumn('grantId', 'uuid', (c) =>
      c.notNull().references('knowledgeOAuthGrants.id').onDelete('cascade'),
    )
    .addColumn('expiresAt', 'timestamptz', (c) => c.notNull())
    .addColumn('usedAt', 'timestamptz')
    .execute();
  await db.schema
    .createIndex('knowledge_oauth_tokens_grant')
    .on('knowledgeOAuthTokens')
    .column('grantId')
    .execute();
  await db.schema
    .createTable('knowledgeOperations')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('grantId', 'uuid', (c) =>
      c.notNull().references('knowledgeOAuthGrants.id').onDelete('cascade'),
    )
    .addColumn('requestId', 'varchar(100)', (c) => c.notNull())
    .addColumn('name', 'varchar(100)', (c) => c.notNull())
    .addColumn('inputHash', 'varchar(64)', (c) => c.notNull())
    .addColumn('state', 'varchar(16)', (c) => c.notNull())
    .addColumn('receipt', 'jsonb')
    .addColumn('errorCode', 'varchar(64)')
    .addColumn('createdAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('finishedAt', 'timestamptz')
    .execute();
  await db.schema
    .createIndex('knowledge_operation_request')
    .on('knowledgeOperations')
    .columns(['grantId', 'requestId'])
    .unique()
    .execute();
  await db.schema
    .createTable('knowledgeFileTickets')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('grantId', 'uuid', (c) =>
      c.notNull().references('knowledgeOAuthGrants.id').onDelete('cascade'),
    )
    .addColumn('tokenHash', 'varchar(64)', (c) => c.notNull())
    .addColumn('purpose', 'varchar(16)', (c) => c.notNull())
    .addColumn('data', 'jsonb', (c) => c.notNull())
    .addColumn('expiresAt', 'timestamptz', (c) => c.notNull())
    .addColumn('usedAt', 'timestamptz')
    .addColumn('receipt', 'jsonb')
    .execute();
  await db.schema
    .createTable('knowledgeMailProfiles')
    .addColumn('userId', 'uuid', (c) =>
      c.primaryKey().references('users.id').onDelete('cascade'),
    )
    .addColumn('workspaceId', 'uuid', (c) =>
      c.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('email', 'varchar(254)', (c) => c.notNull())
    .addColumn('verifiedAt', 'timestamptz')
    .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(false))
    .execute();
  await db.schema
    .createTable('knowledgeMailVerification')
    .addColumn('userId', 'uuid', (c) =>
      c.primaryKey().references('users.id').onDelete('cascade'),
    )
    .addColumn('email', 'varchar(254)', (c) => c.notNull())
    .addColumn('codeHash', 'varchar(64)', (c) => c.notNull())
    .addColumn('expiresAt', 'timestamptz', (c) => c.notNull())
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('createdAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createTable('knowledgeMailOutbox')
    .addColumn('notificationId', 'uuid', (c) =>
      c.primaryKey().references('notifications.id').onDelete('cascade'),
    )
    .addColumn('state', 'varchar(16)', (c) => c.notNull().defaultTo('pending'))
    .addColumn('createdAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('finishedAt', 'timestamptz')
    .addColumn('errorCode', 'varchar(64)')
    .execute();
}
export async function down(db: Kysely<any>) {
  if (
    await db
      .selectFrom('knowledgeOAuthGrants')
      .select('id')
      .limit(1)
      .executeTakeFirst()
  )
    throw new Error(
      'OAuth grants exist; stop the application and restore a verified snapshot to roll back.',
    );
  for (const t of [
    'knowledgeMailOutbox',
    'knowledgeMailVerification',
    'knowledgeMailProfiles',
    'knowledgeFileTickets',
    'knowledgeOperations',
    'knowledgeOAuthTokens',
    'knowledgeOAuthGrants',
    'knowledgeOAuthRequests',
    'knowledgeOAuthClients',
  ])
    await db.schema.dropTable(t).execute();
}
