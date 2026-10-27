import { sql, eq } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { DrizzleDatabaseManager } from '../../server/common/selfhost/database';
import { RequestContextService } from '../../server/common/selfhost/context';
import { iterationConfiguration } from '../../server/database/schema';
import { WorkspaceRecordStore } from '../../server/database/workspace-record.store';

describe('selfhost SQL identities and Drizzle builders', () => {
  const context = new RequestContextService();
  let manager: DrizzleDatabaseManager, owner: Sql;
  const iterationId = `test-${randomUUID()}`;
  beforeAll(async () => {
    if (!process.env.MAKIT_MIGRATION_DATABASE_URL || new URL(process.env.MAKIT_MIGRATION_DATABASE_URL).hostname !== '127.0.0.1') {
      throw new Error('Isolated local owner credential required');
    }
    owner = postgres(process.env.MAKIT_MIGRATION_DATABASE_URL, { max: 1 });
    manager = new DrizzleDatabaseManager(context);
    await manager.assertRuntimeRole();
  });
  afterAll(async () => {
    await owner`DELETE FROM iteration_configuration WHERE iteration_id = ${iterationId}`;
    await owner.end(); await manager.onModuleDestroy();
  });
  it('isolates concurrent execute and mapped select query contexts', async () => {
    await Promise.all(Array.from({ length: 18 }, async (_, index) => {
      const id = `actor-${index}`;
      await context.run({ userId: id, roles: ['viewer'] }, async () => {
        const raw = await manager.getDatabase().execute<{ actor: string }>(sql`SELECT current_setting('app.user_id') AS actor`);
        expect(raw[0].actor).toBe(id);
        const rows = await manager.getDatabase().select({
          actor: sql<string>`current_setting('app.user_id')`,
          role: sql<string>`current_setting('role')`,
        }).from(sql`(SELECT 1) AS one`);
        expect(rows[0]).toEqual({ actor: id, role: 'authenticated_public' });
      });
    }));
    const rows = await manager.getDatabase().execute<{ actor: string; role: string }>(sql`
      SELECT current_setting('app.user_id') AS actor, current_setting('role') AS role
    `);
    expect(rows[0]).toEqual({ actor: '', role: 'anon_public' });
  });
  it('keeps role RLS, returning-row mapping, and transaction context intact', async () => {
    const db = manager.getDatabase();
    await expect(context.run({ userId: 'test-member', roles: ['viewer'] }, async () =>
      await db.insert(iterationConfiguration).values({ iterationId, draftJson: '{}' }).returning(),
    )).rejects.toThrow();
    const created = await context.run({ userId: 'test-admin', roles: ['admin'] }, async () =>
      await db.insert(iterationConfiguration).values({ iterationId, draftJson: '{}' }).returning(),
    );
    expect(created[0].iterationId).toBe(iterationId);
    const rows = await context.run({ userId: 'test-admin', roles: ['admin'] }, async () =>
      await db.select().from(iterationConfiguration).where(eq(iterationConfiguration.iterationId, iterationId)),
    );
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    expect(rows[0].createdBy).toBe('test-admin');
    await context.run({ userId: 'test-admin', roles: ['admin'] }, async () => db.transaction(async (tx) => {
      await tx.update(iterationConfiguration).set({ revision: 3 }).where(eq(iterationConfiguration.iterationId, iterationId));
      const values = await tx.execute<{ actor: string }>(sql`SELECT current_setting('app.user_id') AS actor`);
      expect(values[0].actor).toBe('test-admin');
    }));
    await expect(db.select().from(iterationConfiguration).where(eq(iterationConfiguration.iterationId, iterationId)))
      .resolves.toEqual([]);
  });
  it('does not let Drizzle serializer changes corrupt raw JSON repositories', async () => {
    const store = new WorkspaceRecordStore(manager.client);
    const collection = `test-${randomUUID()}`;
    await owner`INSERT INTO makit_collection (id,kind,fields) VALUES (${collection},${collection},'[]')`;
    try {
      const record = await store.createRecord(collection, { message: '中文 JSON', nested: { number: 1 } });
      expect(record.fields).toMatchObject({ message: '中文 JSON', nested: { number: 1 } });
    } finally {
      await owner`DELETE FROM makit_record WHERE collection_id=${collection}`;
      await owner`DELETE FROM makit_collection WHERE id=${collection}`;
    }
  });
});
