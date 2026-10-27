import { ServiceUnavailableException } from '@nestjs/common';
import type {
  DataPaasConfig,
  DrizzleDatabaseManager,
  PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import type { Sql, TransactionSql } from 'postgres';
import { ServiceRoleDatabaseExecutor } from '../../server/database/service-role-database.executor';

interface ExecutorHarness {
  executor: ServiceRoleDatabaseExecutor;
  begin: jest.Mock;
  transaction: TransactionSql & jest.Mock;
  unsafe: jest.Mock;
  rootExecute: jest.Mock;
}

function executorHarness(roleSchema: string): ExecutorHarness {
  const unsafe = jest
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ value: 1 }]);
  const transaction = jest
    .fn()
    .mockResolvedValue([
      { effective_role: `service_role_${roleSchema}` },
    ]) as unknown as TransactionSql & jest.Mock;
  transaction.unsafe = unsafe;
  const begin = jest.fn(
    async <T>(operation: (db: TransactionSql) => Promise<T>): Promise<T> =>
      operation(transaction),
  );
  const rootExecute = jest.fn();
  const rootDb = {
    execute: rootExecute,
    $client: { begin } as unknown as Sql,
  } as unknown as PostgresJsDatabase;
  const databaseManager = {
    getDatabase: jest.fn().mockReturnValue(rootDb),
  } as unknown as DrizzleDatabaseManager;
  return {
    executor: new ServiceRoleDatabaseExecutor(databaseManager, {
      connectionString: '',
      roleSchema,
    } as DataPaasConfig),
    begin,
    transaction,
    unsafe,
    rootExecute,
  };
}

describe('ServiceRoleDatabaseExecutor', () => {
  it('keeps role setup and operations on the raw transaction client', async () => {
    const harness = executorHarness('workspace_aadknhjojzqdw');
    const operation = jest.fn(
      async (database: PostgresJsDatabase): Promise<number> => {
        const rows = await database.execute<{ value: number }>(
          sql`SELECT 1 AS value`,
        );
        return rows[0]?.value || 0;
      },
    );

    await expect(harness.executor.run(operation)).resolves.toBe(1);

    expect(harness.begin).toHaveBeenCalledTimes(1);
    expect(harness.unsafe).toHaveBeenCalledTimes(3);
    expect(harness.unsafe.mock.calls[0][0]).toContain(
      'SET LOCAL ROLE "service_role_workspace_aadknhjojzqdw"',
    );
    expect(harness.unsafe.mock.calls[1][0]).toContain('app.user_id');
    expect(harness.unsafe.mock.calls[2][0]).toContain('SELECT 1 AS value');
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.rootExecute).not.toHaveBeenCalled();
  });

  it('normalizes Date parameters before using the raw transaction client', async () => {
    const harness = executorHarness('workspace_aadknhjojzqdw');
    const timestamp = new Date('2026-08-16T00:00:00.000Z');

    await harness.executor.run(async (database: PostgresJsDatabase) => {
      await database.execute(sql`SELECT ${timestamp}::timestamptz`);
    });

    const queryCall = harness.unsafe.mock.calls[2];
    expect(queryCall[0]).toContain('::timestamptz');
    expect(queryCall[1]).toEqual([timestamp.toISOString()]);
  });

  it('fails closed when the role schema or raw client is missing', async () => {
    for (const roleSchema of ['', 'workspace;RESET ROLE']) {
      const harness = executorHarness(roleSchema);
      const operation = jest.fn();
      await expect(harness.executor.run(operation)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(harness.begin).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
    }

    const databaseManager = {
      getDatabase: jest.fn().mockReturnValue({ execute: jest.fn() }),
    } as unknown as DrizzleDatabaseManager;
    const executor = new ServiceRoleDatabaseExecutor(
      databaseManager,
      {
        connectionString: '',
        roleSchema: 'workspace_aadknhjojzqdw',
      } as DataPaasConfig,
    );
    await expect(executor.run(jest.fn())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not run the operation when SET LOCAL ROLE fails', async () => {
    const harness = executorHarness('workspace_aadknhjojzqdw');
    harness.unsafe.mockReset().mockRejectedValueOnce(new Error('permission denied'));
    const operation = jest.fn();

    await expect(harness.executor.run(operation)).rejects.toThrow(
      'permission denied',
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not run the operation when the effective role was overwritten', async () => {
    const harness = executorHarness('workspace_aadknhjojzqdw');
    harness.transaction.mockResolvedValueOnce([
      { effective_role: 'authenticated_workspace_aadknhjojzqdw' },
    ]);
    const operation = jest.fn();

    await expect(harness.executor.run(operation)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(operation).not.toHaveBeenCalled();
  });
});
