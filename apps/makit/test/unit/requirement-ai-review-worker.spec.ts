import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { RequirementAiReviewService } from '../../server/modules/requirements/requirement-ai-review.service';

interface WorkerInternals {
  processPending(): Promise<void>;
  processOne(id: string): Promise<boolean>;
  callModel(): Promise<unknown>;
  dispatchPending(): void;
  processing: boolean;
  logger: { error(message: string): void };
}

function harness() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const execute = jest.fn(
    async (query: SQL): Promise<Record<string, unknown>[]> => {
      queries.push(new PgDialect().sqlToQuery(query));
      return [];
    },
  );
  const service = new RequirementAiReviewService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      run: async (operation: (db: unknown) => Promise<unknown>) =>
        operation({ execute }),
    } as never,
  );
  const worker = service as unknown as WorkerInternals;
  const error = jest
    .spyOn(worker.logger, 'error')
    .mockImplementation(() => undefined);
  return { service, worker, execute, queries, error };
}

describe('AI review worker lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('claims a queued task, records an attempt, and completes using a mocked model', async () => {
    const { worker, execute, queries } = harness();
    const row = {
      id: 'review-1',
      batch_id: 'batch-1',
      attempts: 1,
      source_hash: 'hash',
      model: 'test-model',
      rule_set_version: 'test-rule',
      review_type: 'clarity',
      source_snapshot: 'material',
    };
    execute.mockImplementation(async (query: SQL) => {
      const compiled = new PgDialect().sqlToQuery(query);
      queries.push(compiled);
      if (compiled.sql.includes('pg_try_advisory_xact_lock'))
        return [{ acquired: true }];
      if (compiled.sql.includes('count(*)')) return [{ count: 0 }];
      if (compiled.sql.includes('RETURNING *')) return [row];
      if (compiled.sql.includes('RETURNING superseded_at'))
        return [{ superseded_at: null }];
      return [];
    });
    const model = jest.spyOn(worker, 'callModel').mockResolvedValue({
      score: 90,
      verdict: 'passed',
      summary: 'clear',
      dimensions: [],
      findings: [],
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheHitTokens: null,
        cacheMissTokens: null,
      },
      providerRequestId: null,
    });
    await expect(worker.processOne('review-1')).resolves.toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    expect(queries.map((query) => query.sql).join('\n')).toContain(
      'INSERT INTO requirement_ai_review_execution',
    );
    expect(queries.at(-1)?.params).toContain('completed');
    expect(queries.at(-1)?.params).toContain(null); // Unknown usage is not zero.
  });

  it('does not call the model if the global slots are full or another worker claimed the row', async () => {
    for (const active of [3, 0]) {
      const { worker, execute } = harness();
      execute.mockImplementation(async (query: SQL) => {
        const statement = new PgDialect().sqlToQuery(query).sql;
        if (statement.includes('pg_try_advisory_xact_lock'))
          return [{ acquired: true }];
        return statement.includes('count(*)') ? [{ count: active }] : [];
      });
      const model = jest.spyOn(worker, 'callModel');
      await expect(worker.processOne('review-1')).resolves.toBe(false);
      expect(model).not.toHaveBeenCalled();
    }
  });

  it('uses a boolean lock result and skips safely on contention or a missing result', async () => {
    for (const result of [[{ acquired: false }], []]) {
      const { worker, execute, queries } = harness();
      execute.mockImplementation(async (query: SQL) => {
        queries.push(new PgDialect().sqlToQuery(query));
        return result;
      });
      const model = jest.spyOn(worker, 'callModel');
      await expect(worker.processOne('review-1')).resolves.toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(queries[0].sql).toBe(
        'SELECT pg_try_advisory_xact_lock(1100037) AS acquired',
      );
      expect(model).not.toHaveBeenCalled();
    }
  });

  it('keeps the scanner guard until other tasks settle after one claim fails', async () => {
    const { worker, execute, error } = harness();
    execute
      .mockResolvedValueOnce([{ id: 'bad' }, { id: 'slow' }])
      .mockResolvedValue([]);
    let finish: (value: boolean) => void = () => undefined;
    const slow = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    jest
      .spyOn(worker, 'processOne')
      .mockImplementation((id: string) =>
        id === 'bad'
          ? Promise.reject(
              Object.assign(new Error('private SQL'), { code: '42501' }),
            )
          : slow,
      );
    const pending = worker.processPending();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(worker.processing).toBe(true);
    await worker.processPending();
    expect(execute).toHaveBeenCalledTimes(1);
    finish(false);
    await pending;
    expect(worker.processing).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('review=bad'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('42501'));
    expect(error.mock.calls.flat().join('')).not.toContain('private SQL');
  });

  it('releases the guard after a scan error and can run again', async () => {
    const { worker, execute } = harness();
    execute
      .mockRejectedValueOnce(new Error('database offline'))
      .mockResolvedValue([]);
    await expect(worker.processPending()).rejects.toThrow('database offline');
    expect(worker.processing).toBe(false);
    await expect(worker.processPending()).resolves.toBeUndefined();
  });

  it('starts recovery at initialization and stops the interval on destruction', async () => {
    jest.useFakeTimers();
    const { service, worker } = harness();
    const dispatch = jest
      .spyOn(worker, 'dispatchPending')
      .mockImplementation(() => undefined);
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(dispatch).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
