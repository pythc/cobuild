import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, sql } from 'drizzle-orm';
import { githubResourceCache } from '../../database/schema';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';

@Injectable()
export class GitHubResourceCacheService {
  constructor(private readonly serviceDatabase: ServiceRoleDatabaseExecutor) {}

  async conditional<T>(repository: string, resourceKey: string,
    fetcher: (etag: string | null) => Promise<{ status: number; data: T; etag: string | null }>): Promise<T> {
    if (!resourceKey.startsWith('/repos/') || resourceKey.length > 512) throw new ServiceUnavailableException('GitHub 缓存资源无效');
    const where = and(eq(githubResourceCache.repository, repository), eq(githubResourceCache.resourceKey, resourceKey));
    const rows = await this.serviceDatabase.run((db: PostgresJsDatabase) => db.execute(sql`SELECT etag,body_json FROM ${githubResourceCache} WHERE ${where}`)) as unknown as Array<{ etag: string | null; body_json: string }>;
    const saved = rows[0];
    const response = await fetcher(saved?.etag || null);
    if (response.status !== 200 && response.status !== 304) throw new ServiceUnavailableException('GitHub 条件请求未成功');
    if (response.status === 304 && !saved) throw new ServiceUnavailableException('GitHub 缺少条件请求基线');
    const bodyJson: string = response.status === 304 ? saved.body_json : JSON.stringify(response.data);
    if (Buffer.byteLength(bodyJson) > 10000000) throw new ServiceUnavailableException('GitHub 数据超过安全范围');
    await this.serviceDatabase.run(async (db: PostgresJsDatabase): Promise<void> => {
      await db.execute(db.insert(githubResourceCache).values({ repository, resourceKey, etag: response.etag || saved?.etag || null, bodyJson })
        .onConflictDoUpdate({ target: [githubResourceCache.repository, githubResourceCache.resourceKey],
          set: { etag: response.etag || saved?.etag || null, bodyJson, checkedAt: new Date() } }));
    });
    return JSON.parse(bodyJson) as T;
  }
}
