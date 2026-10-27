import { Injectable, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { RequestContextService } from './context';
export type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
export const DRIZZLE_DATABASE = Symbol('SELFHOST_DRIZZLE_DATABASE');
export const DATAPAAS_CONFIG = Symbol('SELFHOST_DATABASE_CONFIG');
export interface DataPaasConfig { connectionString: string; roleSchema: string }

/** Compatibility DI contract; no managed SDK, request monkey patches or superuser login. */
@Injectable()
export class DrizzleDatabaseManager implements OnModuleDestroy {
  readonly client: Sql;
  private readonly root: PostgresJsDatabase;
  private readonly ormClient: Sql;
  private readonly requestDatabase: PostgresJsDatabase;
  constructor(private readonly context: RequestContextService) {
    if (!process.env.MAKIT_DATABASE_URL) throw new Error('Missing application database URL');
    const maximum = Number(process.env.MAKIT_DATABASE_POOL_SIZE || '8');
    if (!Number.isInteger(maximum) || maximum < 2 || maximum > 32) throw new Error('Invalid database pool size');
    const rawMaximum = Math.max(1, Math.floor(maximum / 4));
    this.client = postgres(process.env.MAKIT_DATABASE_URL, {
      max: rawMaximum, connect_timeout: 5, idle_timeout: 30,
      connection: { application_name: 'makit-selfhost', search_path: 'public' },
      onnotice() {},
    });
    // Drizzle modifies its driver's serializers. Keep raw JSON repositories
    // separate, with both connection pools sharing one configured total cap.
    this.ormClient = postgres(process.env.MAKIT_DATABASE_URL, {
      max: maximum - rawMaximum, connect_timeout: 5, idle_timeout: 30,
      connection: { application_name: 'makit-selfhost-orm', search_path: 'public' }, onnotice() {},
    });
    this.root = drizzle(this.scopedClient());
    this.requestDatabase = new Proxy(this.root, {
      get: (target, property): unknown => {
        if (property === '$client') return this.ormClient;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  getDatabase(): PostgresJsDatabase { return this.requestDatabase; }
  private async scoped<T>(operation: (tx: TransactionSql) => Promise<T>): Promise<T> {
    const identity = this.context.current;
    return this.ormClient.begin(async (tx) => {
      // Connection-local state never escapes a transaction into another request.
      await tx.unsafe(identity?.userId ? 'SET LOCAL ROLE authenticated_public' : 'SET LOCAL ROLE anon_public');
      await tx`SELECT set_config('app.user_id', ${identity?.userId || ''}, true),
        set_config('app.role_ids', ${(identity?.roles || []).join(',')}, true),
        set_config('app.user_type', ${identity?.userId ? 'user' : 'anonymous'}, true)`;
      return operation(tx);
    }) as Promise<T>;
  }
  private scopedClient(): Sql {
    return new Proxy(this.ormClient, {
      get: (target, property): unknown => {
        if (property === 'begin') return (operation: (tx: TransactionSql) => Promise<unknown>) => this.scoped(operation);
        if (property === 'unsafe') return (...args: Parameters<Sql['unsafe']>) => {
          const [text, input = [], options] = args;
          const parameters = input.map((value: unknown) => value instanceof Date ? value.toISOString() : value);
          const query = target.unsafe(text, parameters as never[], options);
          let mode: boolean | undefined;
          let result: Promise<unknown> | undefined;
          const run = (arrays: boolean) => {
            if (mode !== undefined && mode !== arrays) throw new Error('Query result mode cannot change after execution');
            mode = arrays;
            if (!result) result = this.scoped(async (tx) => arrays
              ? tx.unsafe(text, parameters as never[], options).values()
              : tx.unsafe(text, parameters as never[], options));
            return result;
          };
          return new Proxy(query, { get: (pending, key) => {
            if (key === 'values') return () => run(true);
            if (key === 'then') return (...callbacks: Parameters<Promise<unknown>['then']>) => run(false).then(...callbacks);
            if (key === 'catch') return (...callbacks: Parameters<Promise<unknown>['catch']>) => run(false).catch(...callbacks);
            if (key === 'finally') return (...callbacks: Parameters<Promise<unknown>['finally']>) => run(false).finally(...callbacks);
            if (['execute', 'simple', 'cursor', 'readable', 'writable', 'raw', 'forEach'].includes(String(key))) {
              throw new Error('Unsupported query mode; identity scope must not be bypassed');
            }
            const value: unknown = Reflect.get(pending, key, pending);
            return typeof value === 'function' ? value.bind(pending) : value;
          } });
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  async assertRuntimeRole(): Promise<void> {
    const [role] = await this.client<{ rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolname: string }[]>`
      SELECT rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolname FROM pg_roles WHERE rolname = current_user
    `;
    if (!role || role.rolsuper || role.rolbypassrls || role.rolinherit || role.rolcreaterole || role.rolcreatedb || role.rolname !== 'makit_application') {
      throw new UnauthorizedException('Application must use the dedicated restricted database login');
    }
  }
  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.client.end({ timeout: 5 }), this.ormClient.end({ timeout: 5 })]);
  }
}
