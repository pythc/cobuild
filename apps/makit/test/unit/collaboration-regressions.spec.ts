import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQLWrapper } from 'drizzle-orm';
import { PullRequestsService } from '../../server/modules/pull-requests/pull-requests.service';
import { IterationEfficiencyService } from '../../server/modules/operations/iteration-efficiency.service';
import { safeNotificationError } from '../../server/modules/notifications/notification-error.model';

describe('production query regressions', () => {
  it('explicitly aliases snapshot identifiers when reading through the raw background executor', async () => {
    const db = drizzle.mock(),
      calls: string[] = [];
    db.execute = jest.fn(async (query: SQLWrapper) => {
      const sql = new PgDialect().sqlToQuery(query.getSQL()).sql;
      calls.push(sql);
      expect(sql).toContain('as "pullNumber"');
      expect(sql).toContain('as "headRef"');
      expect(sql).toContain('as "baseRef"');
      return [
        {
          pullNumber: 59,
          title: 'test',
          headRef: 'dev/test',
          baseRef: 'iteration',
        },
      ];
    }) as typeof db.execute;
    const service = new PullRequestsService(
      {} as never,
      { repository: () => 'repo' } as never,
      {} as never,
      {} as never,
      {} as never,
      { run: (f: (db: unknown) => unknown) => f(db) } as never,
    );
    const internals = service as unknown as {
      notifyAssignments(rows: unknown[]): Promise<number>;
      notifyReviewer: () => Promise<boolean>;
    };
    const notify = jest
      .spyOn(internals, 'notifyReviewer')
      .mockResolvedValue(true);
    await expect(
      internals.notifyAssignments([{ pullNumber: 59 }]),
    ).resolves.toBe(1);
    expect(calls).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('uses parameterized jsonb_exists instead of the platform-incompatible question-mark operator', async () => {
    const sqls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      execute: jest.fn(async (q: SQLWrapper) => {
        sqls.push(new PgDialect().sqlToQuery(q.getSQL()));
        return [];
      }),
    };
    const service = new IterationEfficiencyService(
      {
        workspace: async () => ({
          iterations: [{ id: 'iteration' }],
          requirements: [{ id: 'recTest', iterationIds: [] }],
        }),
        table: () => 'relations',
      } as never,
      { run: (f: (db: unknown) => unknown) => f(db) } as never,
      { listRecords: async () => [] } as never,
    );
    await service.get('iteration', {
      userId: 'member',
      userName: 'test',
      roles: [],
      appId: 'test',
    });
    const events = sqls.find((q) =>
      q.sql.includes('requirement_business_event'),
    )!;
    expect(events.sql).toContain('jsonb_exists');
    expect(events.sql).not.toMatch(/\?\s*\$/u);
    expect(events.params).toContain('iteration');
  });
  it('distinguishes missing PR snapshots from deleted requirements without leaking raw errors', () => {
    expect(safeNotificationError('未找到对应的合并请求快照')).toContain(
      '合并请求快照',
    );
    expect(safeNotificationError('provider: secret-token')).not.toContain(
      'secret-token',
    );
    expect(safeNotificationError('')).toBe('');
  });
});
