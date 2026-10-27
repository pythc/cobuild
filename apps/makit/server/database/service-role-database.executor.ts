import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  DATAPAAS_CONFIG,
  type DataPaasConfig,
  DrizzleDatabaseManager,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AsyncResource } from 'node:async_hooks';
import type { Sql, TransactionSql } from 'postgres';

type ServiceRoleOperation<T> = (db: PostgresJsDatabase) => Promise<T>;

/**
 * Runs a small database-only operation as the application's service role.
 *
 * DataPaas normally installs the SQL role through HTTP middleware. Timers and
 * crash-recovery workers have no request context, while request-triggered
 * fire-and-forget work can accidentally inherit an authenticated/anonymous
 * context. This executor clears that context and applies the same service role
 * explicitly inside one transaction. It must never wrap remote I/O.
 */
@Injectable()
export class ServiceRoleDatabaseExecutor {
  private readonly detachedScope: AsyncResource = new AsyncResource(
    'ServiceRoleDatabaseExecutor',
  );
  private readonly serviceRole: string;
  private readonly dialect: PgDialect = new PgDialect();

  constructor(
    private readonly databaseManager: DrizzleDatabaseManager,
    @Inject(DATAPAAS_CONFIG)
    config: DataPaasConfig,
  ) {
    const roleSchema: string = String(config.roleSchema || '').trim();
    if (!/^[a-z_][a-z0-9_]*$/iu.test(roleSchema)) {
      this.serviceRole = '';
      return;
    }
    this.serviceRole = `service_role_${roleSchema}`;
  }

  async run<T>(operation: ServiceRoleOperation<T>): Promise<T> {
    const client: Sql | undefined = (
      this.databaseManager.getDatabase() as PostgresJsDatabase & {
        $client?: Sql;
      }
    ).$client;
    if (!this.serviceRole || !client || typeof client.begin !== 'function') {
      throw new ServiceUnavailableException('后台数据库执行身份尚未就绪');
    }
    return this.detachedScope.runInAsyncScope(
      (): Promise<T> =>
        client.begin(async (transaction): Promise<T> => {
          // The DataPaaS package wraps every Drizzle prepared query and may
          // replay the originating HTTP user's role before that query. A
          // background job started from a request would therefore be reset to
          // authenticated_* immediately after SET LOCAL ROLE and fail the
          // worker-only RPC. Use the underlying transaction client for both
          // role setup and execution so request middleware cannot overwrite
          // the worker identity between statements.
          await transaction.unsafe(`SET LOCAL ROLE "${this.serviceRole}"`);
          await transaction.unsafe(`
            SELECT
              set_config('app.user_id', '', true),
              set_config('app.role_ids', '', true),
              set_config('app.user_type', 'system', true)
          `);
          const roleRows = await transaction<Array<{ effective_role: string }>>`
            SELECT current_setting('role', true) AS effective_role
          `;
          if (roleRows[0]?.effective_role !== this.serviceRole) {
            throw new ServiceUnavailableException('后台数据库执行身份校验失败');
          }
          return operation(this.database(transaction));
        }) as Promise<T>,
    );
  }

  /**
   * Builds a transaction-scoped Drizzle facade whose execute() method talks
   * straight to postgres.js instead of the DataPaaS prepared-query monkey
   * patch. Query builders are delegated to the current managed Drizzle
   * instance, then compiled and executed through the raw transaction. This
   * avoids constructing Drizzle with postgres.js' TransactionSql, whose
   * runtime shape intentionally does not expose the root client's parsers.
   */
  private database(transaction: TransactionSql): PostgresJsDatabase {
    const managedDatabase: PostgresJsDatabase =
      this.databaseManager.getDatabase();
    const execute = <T extends Record<string, unknown>>(
      query: SQLWrapper | string,
    ): Promise<T[]> => {
      const wrapper: SQLWrapper =
        typeof query === 'string' ? sql.raw(query) : query;
      const compiled = this.dialect.sqlToQuery(wrapper.getSQL());
      // DataPaaS installs Drizzle-oriented postgres.js serializers on the
      // managed client. Those serializers intentionally leave Date values for
      // Drizzle's prepared-query layer to encode, but this executor bypasses
      // that layer and sends the compiled query through transaction.unsafe().
      // Normalize dates here so postgres.js never attempts to write a Date
      // object directly into its wire buffer. The SQL produced by Drizzle
      // retains the target casts (for example ::timestamptz).
      const parameters: unknown[] = compiled.params.map(
        (parameter: unknown): unknown =>
          parameter instanceof Date ? parameter.toISOString() : parameter,
      );
      return transaction
        .unsafe<T[]>(compiled.sql, parameters as never[])
        .then((rows): T[] => Array.from(rows));
    };
    return new Proxy(managedDatabase, {
      get: (target, property): unknown => {
        if (property === 'execute') {
          return execute as PostgresJsDatabase['execute'];
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}
