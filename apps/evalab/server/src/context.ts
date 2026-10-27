import type { Pool } from 'pg';
import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import { bootstrapAdmin } from './bootstrap.js';
import { createPool, migrate } from './db.js';

export type RepoLookup = { url: string; branch?: string };
export type RepoCommitMeta = {
  url: string;
  branch: string;
  sha: string;
  message: string;
  author: string;
  committedAt: string;
};
export type RepoFetcher = (input: RepoLookup) => Promise<RepoCommitMeta>;

export type AppContext = {
  pool: Pool;
  config: AppConfig;
  /** Test-only override. Ignored when nodeEnv is production. */
  repoFetcher?: RepoFetcher;
};

export async function createContext(): Promise<AppContext> {
  const loaded = loadConfig(process.env);
  const pool = createPool(loaded.startup.databaseUrl, loaded.config.dbSchema);
  try {
    await migrate(pool, loaded.config.dbSchema);
    await bootstrapAdmin(pool, loaded.startup);
    const ctx: AppContext = { pool, config: loaded.config };
    if (loaded.config.seedDemo) {
      const { seedDemo } = await import('./demoSeed.js');
      await seedDemo(ctx);
    }
    return ctx;
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.pool.end();
}
