import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import type { SQLWrapper } from 'drizzle-orm';
import {
  NotificationsReadService,
  notificationStatusPredicate,
} from '../../server/modules/notifications/notifications-read.service';

describe('NotificationsReadService', () => {
  it('uses only bounded SELECT projections with raw-row aliases and existing audit semantics', async () => {
    const queries: string[] = [];
    const builder = new QueryBuilder();
    const results = [
      [
        {
          total: 3,
          pending: 0,
          retrying: 1,
          failed: 0,
          delivered: 1,
          suppressed: 1,
        },
      ],
      [{ total: 2 }],
      [
        {
          id: 'event-1',
          repository: 'pythc/ai-homework-system',
          pullNumber: 38,
          reviewerName: '评审同学',
          reviewerEmployeeId: 'person-1',
          githubLogin: 'reviewer',
          assignedByName: '操作同学',
          assignedByUserId: 'actor-1',
          maxNotificationAttempts: 8,
          notificationAttempts: 2,
          notificationError: '503 provider payload do-not-expose',
          suppressionReason: null,
          suppressedAt: null,
          createdAt: '2026-09-12T00:00:00Z',
          updatedAt: '2026-09-12T01:00:00Z',
          notifiedAt: null,
          pullTitle: 'PR title',
          pullExternalUrl: null,
        },
      ],
    ];
    const execute = jest.fn().mockImplementation(async (query: SQLWrapper) => {
      const compiled = new PgDialect().sqlToQuery(query.getSQL());
      queries.push(compiled.sql);
      return results.shift();
    });
    const service = new NotificationsReadService({
      run: async (operation: (db: unknown) => Promise<unknown>) =>
        operation({
          select: builder.select.bind(builder),
          execute,
        }),
    } as never);

    const result = await service.list('retrying', 1, 25);
    expect(execute).toHaveBeenCalledTimes(3);
    for (const query of queries) {
      expect(query).toMatch(/^select /);
      expect(query).not.toMatch(/\b(update|insert|delete|set_config)\b/i);
    }
    expect(queries[0]).toContain(
      '"notification_attempts" >= "pull_request_reviewer_notification_event"."max_notification_attempts"',
    );
    expect(queries[1]).toContain(
      '"assignment_generation" > "pull_request_reviewer_state"."notified_generation"',
    );
    expect(queries[1]).toContain('"pending_policy_mode" is not null');
    for (const alias of [
      'pullNumber',
      'reviewerName',
      'notifiedAt',
      'createdAt',
      'notificationAttempts',
      'suppressedAt',
    ]) {
      expect(queries[2]).toContain(`as "${alias}"`);
    }
    expect(queries[2]).toContain('left join');
    expect(queries[2]).toContain('limit');
    expect(result.stats).toEqual({
      total: 3,
      pending: 0,
      retrying: 1,
      failed: 0,
      delivered: 1,
      suppressed: 1,
      reconciling: 2,
    });
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      status: 'retrying',
      attempts: 2,
      recipientName: '评审同学',
      pullNumber: 38,
    });
    expect(JSON.stringify(result)).not.toContain('do-not-expose');
    expect(result.items[0].pullPlatformUrl).toContain('/pull-requests/38');
  });

  it('keeps delivered precedence over suppressed and suppressed terminal', () => {
    const dialect = new PgDialect();
    const delivered = dialect.sqlToQuery(
      notificationStatusPredicate('delivered'),
    ).sql;
    const suppressed = dialect.sqlToQuery(
      notificationStatusPredicate('suppressed'),
    ).sql;
    const pending = dialect.sqlToQuery(
      notificationStatusPredicate('pending'),
    ).sql;
    expect(delivered).toContain('"notified_at" is not null');
    expect(suppressed).toContain('"notified_at" is null');
    expect(suppressed).toContain('"suppressed_at" is not null');
    expect(pending).toContain('"suppressed_at" is null');
  });

  it('propagates database failure', async () => {
    const service = new NotificationsReadService({
      run: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as never);
    await expect(service.list(undefined, 1, 25)).rejects.toThrow(
      'database unavailable',
    );
  });
});
