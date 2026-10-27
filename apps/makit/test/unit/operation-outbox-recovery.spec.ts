import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { RequirementOperationOutboxService } from '../../server/modules/requirements/requirement-operation-outbox.service';
import { RequirementOperationRecoveryController } from '../../server/modules/requirements/requirement-operation-recovery.controller';
describe('outbox and manual recovery guardrails', () => {
  it('reviews current material through the worker read without invoking notifications', async () => {
    const event = { requirement_id: 'rec_test', actor_user_id: 'actor',
      before_json: JSON.stringify({ id: 'rec_test', introduction: 'old' }),
      after_json: JSON.stringify({ id: 'rec_test', introduction: 'intermediate' }) };
    const execute = jest.fn().mockResolvedValue([event]);
    const actor = { miaodaUserId: 'actor' };
    const latest = { id: 'rec_test', introduction: 'latest' };
    const query = { requirementByIdForWorker: jest.fn().mockResolvedValue(latest), requirementByIdAs: jest.fn() };
    const ai = { onRequirementUpdated: jest.fn().mockResolvedValue(undefined) };
    const deliveries = { recordRequirementEvent: jest.fn() };
    const service = new RequirementOperationOutboxService(
      { run: (fn: (db: unknown) => unknown) => fn({ execute }) } as never,
      {} as never, query as never,
      { currentActor: jest.fn().mockResolvedValue(actor) } as never,
      ai as never, deliveries as never, {} as never, {} as never,
    );
    const callable = service as unknown as { consume(row: unknown): Promise<void>; finish: jest.Mock };
    const finish = jest.spyOn(callable, 'finish').mockResolvedValue(undefined);
    await callable.consume({ consumer: 'review', event_id: 'event', operation_id: 'operation', attempts: 1 });
    expect(query.requirementByIdForWorker).toHaveBeenCalledWith('rec_test', actor);
    expect(query.requirementByIdAs).not.toHaveBeenCalled();
    expect(ai.onRequirementUpdated).toHaveBeenCalledWith(
      { id: 'rec_test', introduction: 'old' }, latest, actor,
    );
    expect(finish).toHaveBeenCalledWith(expect.anything(), 'succeeded', null);
    expect(deliveries.recordRequirementEvent).not.toHaveBeenCalled();
  });

  it('expired history leases stay uncertain; other exhausted consumers terminate', async () => {
    const queries: string[] = [];
    const db = {
      execute: jest.fn(async (q: SQL) => {
        queries.push(new PgDialect().sqlToQuery(q).sql);
        return [];
      }),
    };
    const service = new RequirementOperationOutboxService(
      { run: (fn: (d: typeof db) => unknown) => fn(db) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { scanner: (_: string, fn: () => unknown) => fn() } as never,
    );
    await service.scan();
    expect(queries[0]).toContain(
      "consumer='history' THEN 'unknown' WHEN attempts>=8 THEN 'failed'",
    );
    expect(queries[1]).toContain('attempts<8');
  });
  it('an ordinary user cannot invoke consumer replay, even with a valid job ID', async () => {
    const run = jest.fn();
    const service = new RequirementOperationRecoveryController(
      { run } as never,
      {} as never,
      {
        currentRoles: jest.fn().mockResolvedValue(['viewer']),
      } as never,
    );
    await expect(
      service.retryConsumers(
        { userContext: { userId: 'test', appId: 'test' } } as never,
        '11111111-1111-4111-8111-111111111111',
        { consumer: 'notification', confirmed: true },
      ),
    ).rejects.toThrow('仅管理员');
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['operations_viewer', 'operations_super_admin'])(
    'admin %s retry still requires a confirmed core write and a failed consumer',
    async (role) => {
      const queries: string[] = [];
      const db = {
        execute: jest.fn(async (q: SQL) => {
          queries.push(new PgDialect().sqlToQuery(q).sql);
          return [];
        }),
      };
      const service = new RequirementOperationRecoveryController(
        { run: (fn: (d: typeof db) => unknown) => fn(db) } as never,
        {
          currentUser: jest.fn().mockResolvedValue({ miaodaUserId: 'test' }),
        } as never,
        {
          currentRoles: jest.fn().mockResolvedValue([role]),
        } as never,
      );
      await expect(
        service.retryConsumers(
          { userContext: { userId: 'test', appId: 'test' } } as never,
          '11111111-1111-4111-8111-111111111111',
          { consumer: 'history', confirmed: true },
        ),
      ).rejects.toThrow('无需重试');
      expect(queries[0]).toContain("status='failed'");
      expect(queries[0]).toContain("j.status='succeeded'");
    },
  );
});
