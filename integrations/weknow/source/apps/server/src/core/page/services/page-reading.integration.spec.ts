import { Kysely, PostgresDialect, CamelCasePlugin, sql } from 'kysely';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PageReadingService } from './page-reading.service';
import { SpaceAccessSummaryService } from '../../space/services/space-access-summary.service';
import { up, down } from '../../../database/migrations/20261014T110000-page-reading-history';

// The persistence tests use real PostgreSQL; existing access enforcement is
// supplied as a boundary so unrelated editor/ESM dependencies are not loaded.
jest.mock('@docmost/db/repos/page/page.repo', () => ({ PageRepo: class PageRepo {} }));
jest.mock('../page-access/page-access.service', () => ({ PageAccessService: class PageAccessService {} }));

jest.setTimeout(30000);
const suite = process.env.READING_TEST_DATABASE_URL ? describe : describe.skip;
suite('reading history and access sources with disposable PostgreSQL', () => {
  let db: Kysely<any>, reading: PageReadingService, accessSummary: SpaceAccessSummaryService;
  const workspaceId = randomUUID(), otherWorkspaceId = randomUUID();
  const user: any = { id: randomUUID(), workspaceId, name: 'Member' };
  const other: any = { id: randomUUID(), workspaceId, name: 'Other' };
  const spaceId = randomUUID(), pageId = randomUUID(), groupId = randomUUID();
  const denied = new Set<string>();
  let outage = false;
  const access = { validateCanView: jest.fn(async (page: any) => {
    if (outage) throw new Error('dependency unavailable');
    if (denied.has(page.id)) throw new ForbiddenException();
  }) };
  beforeAll(async () => {
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.READING_TEST_DATABASE_URL }) }), plugins: [new CamelCasePlugin()] });
    // This URL must point at the dedicated disposable QA database, never the app.
    const name = await sql<{ name: string }>`select current_database() as name`.execute(db);
    if (name.rows[0].name !== 'qa') throw new Error('Expected disposable qa database');
    await sql`drop table if exists page_reading_history, space_members, group_users, groups, pages, spaces, users, workspaces cascade`.execute(db);
    await sql`create table workspaces(id uuid primary key); create table users(id uuid primary key, workspace_id uuid, name text); create table spaces(id uuid primary key, workspace_id uuid, name text, slug text); create table pages(id uuid primary key, workspace_id uuid, space_id uuid, slug_id text, title text, icon text, deleted_at timestamptz); create table groups(id uuid primary key, workspace_id uuid, name text, is_default boolean); create table group_users(group_id uuid,user_id uuid); create table space_members(id uuid primary key,user_id uuid,group_id uuid,space_id uuid,role text)`.execute(db);
    await up(db);
    await db.insertInto('workspaces').values([{ id: workspaceId }, { id: otherWorkspaceId }]).execute();
    await db.insertInto('users').values([user, other]).execute();
    await db.insertInto('spaces').values({ id: spaceId, workspaceId, name: 'Space', slug: 'space' }).execute();
    await db.insertInto('pages').values({ id: pageId, workspaceId, spaceId, slugId: 'page', title: 'Original', icon: null }).execute();
    reading = new PageReadingService(db, { findById: (id: string) => db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirst() } as any, access as any);
    accessSummary = new SpaceAccessSummaryService(db);
  });
  afterAll(async () => { await db?.destroy(); });

  test('concurrent reads update a single receipt and are private to the viewer', async () => {
    await Promise.all(Array.from({ length: 10 }, () => reading.visit(pageId, user)));
    expect((await db.selectFrom('pageReadingHistory').selectAll().execute())).toHaveLength(1);
    expect((await reading.recent(user)).items[0].title).toBe('Original');
    expect((await reading.recent(other)).items).toHaveLength(0);
  });
  test('titles are live and permission revocation hides previously read pages', async () => {
    await db.updateTable('pages').set({ title: 'Updated' }).where('id', '=', pageId).execute();
    expect((await reading.recent(user)).items[0].title).toBe('Updated');
    denied.add(pageId);
    expect((await reading.recent(user)).items).toHaveLength(0);
    await expect(reading.visit(pageId, user)).rejects.toBeInstanceOf(ForbiddenException);
    denied.clear();
  });
  test('a resolved slug records the canonical page ID', async () => {
    const resolver = { findById: () => db.selectFrom('pages').selectAll().where('id', '=', pageId).executeTakeFirst() };
    const service = new PageReadingService(db, resolver as any, access as any);
    await service.visit('page', user);
    expect(await db.selectFrom('pageReadingHistory').selectAll().where('pageId', '=', pageId).execute()).toHaveLength(1);
  });
  test('cross-workspace and deleted pages cannot create receipts', async () => {
    await expect(reading.visit(pageId, { ...user, workspaceId: otherWorkspaceId })).rejects.toBeInstanceOf(NotFoundException);
    await db.updateTable('pages').set({ deletedAt: new Date() }).where('id', '=', pageId).execute();
    expect((await reading.recent(user)).items).toHaveLength(0);
    await expect(reading.visit(pageId, user)).rejects.toBeInstanceOf(NotFoundException);
    await db.updateTable('pages').set({ deletedAt: null }).where('id', '=', pageId).execute();
  });
  test('permission backend errors remain errors instead of an empty successful list', async () => {
    outage = true;
    await expect(reading.recent(user)).rejects.toThrow('dependency unavailable');
    outage = false;
  });
  test('retention is bounded and the newest six are returned', async () => {
    const pages = Array.from({ length: 105 }, (_, i) => ({ id: randomUUID(), workspaceId, spaceId, slugId: 'p' + i, title: 'Page ' + i }));
    await db.insertInto('pages').values(pages).execute();
    for (const page of pages) await reading.visit(page.id, user);
    expect((await db.selectFrom('pageReadingHistory').selectAll().where('userId', '=', user.id).execute())).toHaveLength(100);
    const result = await reading.recent(user);
    expect(result.items).toHaveLength(6);
    expect(result.items[0].id).toBe(pages[pages.length - 1].id);
  });
  test('a receipt is removed when its document is permanently deleted', async () => {
    await reading.visit(pageId, user);
    await db.deleteFrom('pages').where('id', '=', pageId).execute();
    expect(await db.selectFrom('pageReadingHistory').selectAll().where('pageId', '=', pageId).execute()).toHaveLength(0);
  });
  test('access explains direct and group roles without exposing unrelated groups', async () => {
    await db.insertInto('groups').values([{ id: groupId, workspaceId, name: 'Everyone', isDefault: true }, { id: randomUUID(), workspaceId, name: 'Private', isDefault: false }]).execute();
    await db.insertInto('groupUsers').values({ groupId, userId: user.id }).execute();
    await db.insertInto('spaceMembers').values([{ id: randomUUID(), userId: user.id, groupId: null, spaceId, role: 'reader' }, { id: randomUUID(), userId: null, groupId, spaceId, role: 'writer' }]).execute();
    const result = await accessSummary.forUser(spaceId, user);
    expect(result.role).toBe('writer');
    expect(result.sources.map(s => s.type)).toEqual(['direct', 'group']);
    expect(result.sources.some(s => s.name === 'Private')).toBe(false);
  });
  test('group removal takes effect, nonmembers and other workspaces are denied', async () => {
    await db.deleteFrom('groupUsers').where('userId', '=', user.id).execute();
    expect((await accessSummary.forUser(spaceId, user)).role).toBe('reader');
    await expect(accessSummary.forUser(spaceId, other)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(accessSummary.forUser(spaceId, { ...user, workspaceId: otherWorkspaceId })).rejects.toBeInstanceOf(NotFoundException);
  });
  test('additive migration can roll back and reapply without changing documents or accounts', async () => {
    const before = await db.selectFrom('pages').select('id').execute();
    await down(db); await up(db);
    expect((await db.selectFrom('pages').select('id').execute())).toEqual(before);
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(2);
  });
});
