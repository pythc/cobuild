import { WritingService } from './writing.service';
import { writingWeek } from './writing-policy';

describe('writing statistics permission and week boundaries', () => {
  function fixture(spaces = ['team']) {
    const filters: { table: string; args: any[] }[] = [];
    const tables: string[] = [];
    // An old activity-created count must never be added to the page query count.
    const rows = [
      { pageId: 'visible', userId: 'a', name: 'A', characters: 10, edits: 2, createdPages: 99 },
      { pageId: 'restricted', userId: 'b', name: 'B', characters: 100, edits: 3, createdPages: 99 },
    ];
    const creations = [
      { pageId: 'visible', userId: 'a' },
      // This child has no activity record: it predates the feature launch.
      { pageId: 'before-tracking-child', userId: 'a' },
      { pageId: 'restricted', userId: 'b' },
    ];
    const db: any = {
      selectFrom(table: string) {
        tables.push(table);
        const q: any = {};
        for (const method of ['innerJoin', 'select', 'groupBy']) q[method] = () => q;
        q.where = (...args: any[]) => { filters.push({ table, args }); return q; };
        q.executeTakeFirst = async () => ({ startedAt: new Date('2026-10-16T19:54:51Z') });
        q.execute = async () => table === 'users'
          ? [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]
          : table === 'pages as p' ? creations : rows;
        return q;
      },
    };
    const permissions: any = { filterAccessiblePageIds: jest.fn(async () => ['visible', 'before-tracking-child']) };
    const service = new WritingService(db, { getUserSpaceIds: async () => spaces } as any, permissions);
    return { service, filters, permissions, tables };
  }
  test('counts accessible historical children once and never adds legacy activity creation counts', async () => {
    const { service, permissions } = fixture();
    const result = await service.weekly({ id: 'viewer', workspaceId: 'workspace' } as any);
    expect(result.members.map(m => [m.userId, m.characters, m.edits, m.createdPages])).toEqual([
      ['a', 10, 2, 2], ['b', 0, 0, 0], ['c', 0, 0, 0],
    ]);
    expect(permissions.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['visible', 'restricted', 'before-tracking-child'], userId: 'viewer',
    });
  });
  test('uses the entire Beijing week and the same private/deleted/workspace boundaries for creations', async () => {
    const { service, filters } = fixture();
    await service.weekly({ id: 'viewer', workspaceId: 'workspace' } as any);
    const creations = filters.filter(f => f.table === 'pages as p').map(f => f.args);
    const activity = filters.filter(f => f.table === 'writingActivity as a').map(f => f.args);
    const week = writingWeek();
    for (const f of [
      ['s.isPersonal', '=', false], ['s.deletedAt', 'is', null], ['p.deletedAt', 'is', null],
      ['p.nodeType', '=', 'page'], ['p.workspaceId', '=', 'workspace'], ['u.workspaceId', '=', 'workspace'],
      ['u.deletedAt', 'is', null], ['u.deactivatedAt', 'is', null], ['p.spaceId', 'in', ['team']],
    ]) { expect(creations).toContainEqual(f); expect(activity).toContainEqual(f); }
    expect(creations).toContainEqual(['p.createdAt', '>=', week.start]);
    expect(creations).toContainEqual(['p.createdAt', '<', week.end]);
    expect(creations.some(f => f[0] === 'p.parentPageId')).toBe(false);
    expect(activity).toContainEqual(['a.workspaceId', '=', 'workspace']);
  });
  test('does not query private pages when the viewer has no team spaces', async () => {
    const { service, permissions, tables } = fixture([]);
    const result = await service.weekly({ id: 'viewer', workspaceId: 'workspace' } as any);
    expect(result.members.every(m => m.characters === 0 && m.edits === 0 && m.createdPages === 0)).toBe(true);
    expect(tables).not.toContain('pages as p');
    expect(tables).not.toContain('writingActivity as a');
    expect(permissions.filterAccessiblePageIds).toHaveBeenCalledWith({ pageIds: [], userId: 'viewer' });
  });
});
