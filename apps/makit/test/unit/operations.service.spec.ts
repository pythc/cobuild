import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQLWrapper } from 'drizzle-orm';
import type { OperationsAccess } from '@shared/api.interface';
import { OperationsService } from '../../server/modules/operations/operations.service';
import {
  operationRecord,
  safeOperationError,
  type StoredOperation,
} from '../../server/modules/operations/operations.model';
import type { ServiceRoleDatabaseExecutor } from '../../server/database/service-role-database.executor';

const access: OperationsAccess = {
  userId: 'member-1',
  role: 'member',
  canViewAll: false,
  canManageAdmins: false,
  canViewNotifications: false,
};
const sample: StoredOperation = {
  id: '11111111-2222-3333-4444-555555555555',
  requirementId: 'rectest',
  actorUserId: 'member-1',
  actorUserName: '测试成员',
  inputJson: JSON.stringify({
    input: {
      intent: 'status-transition',
      patch: {
        status: '开发中',
        introduction: 'CONFIDENTIAL-DOCUMENT',
        handlerUserIds: ['123'],
      },
    },
  }),
  resultJson: null,
  errorMessage: null,
  createdAt: new Date('2026-09-12T00:00:00Z'),
  finishedAt: null,
  status: 'queued',
  attempts: 0,
};
function setup(results: unknown[][]) {
  const db = drizzle.mock();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  db.execute = jest.fn(async (query: SQLWrapper) => {
    calls.push(new PgDialect().sqlToQuery(query.getSQL()));
    return results.shift() || [];
  }) as typeof db.execute;
  const executor = {
    run: (operation: (database: typeof db) => Promise<unknown>) =>
      operation(db),
  };
  return {
    calls,
    service: new OperationsService(executor as ServiceRoleDatabaseExecutor),
  };
}

describe('operation records read model', () => {
  it('filters the owner inside every SQL query, before counts and pagination', async () => {
    const { service, calls } = setup([
      [{ status: 'queued', count: '1' }],
      [sample],
    ]);
    const response = await service.list(access, {
      scope: 'all',
      page: 1,
      pageSize: 25,
    });
    expect(response.scope).toBe('mine');
    expect(response.stats.queued).toBe(1);
    for (const call of calls) {
      expect(call.sql).toContain('"actor_user_id" =');
      expect(call.params).toContain('member-1');
    }
    expect(calls[1].sql).toContain('as "requirementId"');
    expect(calls[1].sql).toContain('as "actorUserId"');
    expect(calls[1].sql).toContain('limit');
    expect(JSON.stringify(response)).not.toContain('CONFIDENTIAL-DOCUMENT');
    expect(response.items[0].fields).toEqual([
      '状态',
      '需求介绍',
      '当前处理人',
    ]);
  });

  it('permits verified global access but keeps mine filter when selected', async () => {
    const { service, calls } = setup([[], [], [], []]);
    const admin: OperationsAccess = {
      ...access,
      canViewAll: true,
      role: 'operations_admin',
    };
    await service.list(admin, { scope: 'all' });
    expect(calls[0].sql).not.toContain('"actor_user_id" =');
    await service.list(admin, { scope: 'mine' });
    expect(calls[2].params).toContain('member-1');
  });

  it('compares varchar delivery IDs to authorized UUIDs as text without casting native event IDs', async () => {
    const { service, calls } = setup([[{ status: 'queued', count: '1' }], [sample]]);
    await service.list(access, { scope: 'mine' });
    const deliveries = calls.find((call) => call.sql.includes('FROM notification_delivery'))!;
    expect(deliveries.sql).toContain('SELECT owned_operation.id::text');
    expect(deliveries.sql).toContain('"actor_user_id" =');
    expect(deliveries.params).toContain(access.userId);
    expect(deliveries.sql).not.toMatch(/operation_id\s*::\s*uuid/u);
    const outbox = calls.find((call) => call.sql.includes('FROM requirement_operation_outbox'))!;
    expect(outbox.sql).not.toContain('id::text');
  });

  it('does not manufacture delivery or review completion from main-write success', () => {
    const result = operationRecord({
      ...sample,
      status: 'succeeded',
      resultJson: JSON.stringify({
        success: true,
        operationStages: [
          { key: 'write', status: 'succeeded' },
          { key: 'history', status: 'failed' },
          { key: 'review', status: 'succeeded' },
        ],
      }),
    });
    expect(result.stages[0].status).toBe('succeeded');
    expect(result.stages[1].status).toBe('failed');
    expect(result.stages[2].detail).toContain('触发检查');
    expect(result.stages[3].status).toBe('unknown');
  });

  it('redacts untrusted provider payloads and treats timeouts as unconfirmed', () => {
    expect(
      safeOperationError(
        'upstream 502 Authorization: Bearer PRIVATE-SECRET sk-test-secret',
      ),
    ).not.toContain('SECRET');
    const result = operationRecord({
      ...sample,
      status: 'failed',
      errorMessage: 'timeout',
    });
    expect(result.errorCode).toBe('UNCONFIRMED');
    expect(result.stages[0].status).toBe('unknown');
    expect(
      operationRecord({ ...sample, inputJson: 'broken json' }).fields,
    ).toEqual([]);
  });

  it('selects review metadata only with explicit aliases and no source documents', async () => {
    const { service, calls } = setup([[], [{ count: '0' }]]);
    await service.reviews(1, 25);
    expect(calls[0].sql).toContain('as "requirementId"');
    expect(calls[0].sql).toContain('as "reviewType"');
    expect(calls[0].sql).not.toMatch(
      /source_snapshot|findings_json|dimensions_json/u,
    );
  });

  it.each([
    'ETIMEDOUT',
    'AbortError',
    'econnreset',
    'socket hang up',
    'HTTP 502',
    'HTTP 503',
    'HTTP 504',
  ])(
    'does not claim that an uncertain remote write definitely failed: %s',
    (message) => {
      expect(
        operationRecord({ ...sample, status: 'failed', errorMessage: message })
          .stages[0].status,
      ).toBe('unknown');
    },
  );
  it('shows effective updated fields rather than the unpruned intent', () => {
    const result = operationRecord({
      ...sample,
      status: 'succeeded',
      resultJson: JSON.stringify({
        success: true,
        updatedFields: [],
      }),
    });
    expect(result.fields).toEqual([]);
  });
  it('retains actual command field labels without exposing unknown stored content', () => {
    const labels = [
      'Git 分支名称',
      'GitHub 合并请求链接',
      '需求类型',
      '需求来源',
      '开发预计启动时间',
      '开发预计结束时间',
      '预计提测时间',
      '实际开始时间',
      '实际提测时间',
      '实际发布时间',
      '是否阻塞',
    ];
    const result = operationRecord({
      ...sample,
      status: 'succeeded',
      resultJson: JSON.stringify({
        success: true,
        updatedFields: [...labels, 'PRIVATE-DOCUMENT'],
      }),
    });
    expect(result.fields).toEqual(labels);
  });
});
