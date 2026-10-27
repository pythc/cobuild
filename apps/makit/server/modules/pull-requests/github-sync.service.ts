import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { githubSyncRequest, githubWebhookDelivery, pullRequestSnapshot } from '../../database/schema';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import { OperationsTelemetryService } from '../operations/operations-telemetry.service';
import { GitHubPullRequestsService } from './github-pull-requests.service';
import { PullRequestRefreshCoordinatorService } from './pull-request-refresh-coordinator.service';

interface SyncRow { id: string; pull_number: number; requested_generation: number; attempts: number }
export interface GitHubDeliveryEvent {
  deliveryId: string; repository: string; eventName: string; action: string;
  payloadHash: string; pullNumbers: number[];
}

@Injectable()
export class GitHubSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger: Logger = new Logger(GitHubSyncService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastCatchup = 0;
  constructor(private readonly serviceDatabase: ServiceRoleDatabaseExecutor,
    private readonly coordinator: PullRequestRefreshCoordinatorService, private readonly github: GitHubPullRequestsService,
    private readonly telemetry: OperationsTelemetryService) {}

  onModuleInit(): void {
    if (process.env.MAKIT_WORKERS_ENABLED === 'false') return;
    if (process.env.GITHUB_INCREMENTAL_SYNC_ENABLED !== 'true') return;
    this.timer = setInterval((): void => { void this.tick().catch((): void => this.logger.warn('GitHub 增量同步扫描暂未完成')); }, 15000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async accept(event: GitHubDeliveryEvent): Promise<{ duplicate: boolean; queued: number }> {
    return this.serviceDatabase.run(async (db: PostgresJsDatabase): Promise<{ duplicate: boolean; queued: number }> => {
      const inserted = await db.execute(db.insert(githubWebhookDelivery).values({
        deliveryId: event.deliveryId, repository: event.repository, eventName: event.eventName, action: event.action,
        payloadHash: event.payloadHash, pullNumbersJson: JSON.stringify(event.pullNumbers), status: event.pullNumbers.length ? 'queued' : 'ignored',
      }).onConflictDoNothing().returning({ id: githubWebhookDelivery.id })) as unknown as Array<{ id: string }>;
      if (!inserted.length) {
        const previous = await db.execute(sql`SELECT payload_hash FROM ${githubWebhookDelivery} WHERE delivery_id=${event.deliveryId}`) as unknown as Array<{ payload_hash: string }>;
        if (previous[0]?.payload_hash !== event.payloadHash) throw new ConflictException('GitHub 投递标识与内容不一致');
        return { duplicate: true, queued: 0 };
      }
      for (const number of event.pullNumbers) await this.enqueue(db, event.repository, number);
      return { duplicate: false, queued: event.pullNumbers.length };
    });
  }

  async pullNumbersForBranches(branches: string[]): Promise<number[]> {
    if (!branches.length) return [];
    const rows = await this.serviceDatabase.run((db: PostgresJsDatabase) => db.execute(sql`SELECT pull_number FROM ${pullRequestSnapshot}
      WHERE repository=${this.github.repository()} AND state='OPEN' AND head_ref IN (${sql.join(branches.slice(0,100).map((branch: string) => sql`${branch}`), sql`,`)}) LIMIT 100`)) as unknown as Array<{ pull_number: number }>;
    return rows.map((row): number => Number(row.pull_number));
  }

  private async enqueue(db: PostgresJsDatabase, repository: string, number: number, catchup = false): Promise<void> {
    await db.execute(sql`INSERT INTO ${githubSyncRequest} (repository,pull_number) VALUES (${repository},${number})
      ON CONFLICT (repository,pull_number) DO UPDATE SET requested_generation=${githubSyncRequest}.requested_generation+1,
        requested_at=CURRENT_TIMESTAMP, _updated_at=CURRENT_TIMESTAMP,
        state=CASE WHEN ${githubSyncRequest}.state='running' THEN 'running' ELSE 'pending' END,
        attempts=CASE WHEN ${githubSyncRequest}.state='running' THEN ${githubSyncRequest}.attempts ELSE 0 END,
        available_at=CURRENT_TIMESTAMP
      ${catchup ? sql`WHERE ${githubSyncRequest}.requested_at < CURRENT_TIMESTAMP - interval '15 minutes'` : sql``}`);
  }

  private async catchup(): Promise<void> {
    await this.serviceDatabase.run(async (db: PostgresJsDatabase): Promise<void> => {
      // A bounded oldest-first window gradually reconciles open PRs across all Pods.
      const rows = await db.execute(sql`SELECT pull_number FROM ${pullRequestSnapshot} WHERE repository=${this.github.repository()}
        AND state='OPEN' AND synced_at<CURRENT_TIMESTAMP-interval '15 minutes' ORDER BY synced_at LIMIT 20`) as unknown as Array<{ pull_number: number }>;
      for (const row of rows) await this.enqueue(db, this.github.repository(), Number(row.pull_number), true);
    });
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.telemetry.scanner('github_incremental_sync', async (): Promise<void> => {
        if (Date.now() - this.lastCatchup > 60000) { await this.catchup(); this.lastCatchup = Date.now(); }
        const token: string = randomUUID();
        const row = await this.serviceDatabase.run(async (db: PostgresJsDatabase): Promise<SyncRow | null> => {
          const rows = await db.execute(sql`SELECT id,pull_number,requested_generation,attempts FROM ${githubSyncRequest}
            WHERE repository=${this.github.repository()} AND attempts<5 AND ((state IN ('pending','retry_wait') AND available_at<=CURRENT_TIMESTAMP)
              OR (state='running' AND lease_expires_at<=CURRENT_TIMESTAMP))
            ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1`) as unknown as SyncRow[];
          if (!rows[0]) return null;
          await db.execute(sql`UPDATE ${githubSyncRequest} SET state='running',lease_token=${token}::uuid,
            lease_expires_at=CURRENT_TIMESTAMP+interval '120 seconds',claimed_generation=requested_generation,attempts=attempts+1,_updated_at=CURRENT_TIMESTAMP WHERE id=${rows[0].id}::uuid`);
          return rows[0];
        });
        if (!row) return;
        let renewal: Promise<unknown> | null = null;
        const timer = setInterval((): void => {
          if (!renewal) renewal = this.serviceDatabase.run((db: PostgresJsDatabase) => db.execute(sql`UPDATE ${githubSyncRequest}
            SET lease_expires_at=CURRENT_TIMESTAMP+interval '120 seconds' WHERE id=${row.id}::uuid AND lease_token=${token}::uuid
              AND state='running' AND lease_expires_at>CURRENT_TIMESTAMP`)).catch((): void => this.logger.warn('GitHub 同步租约续期失败')).finally((): void => { renewal = null; });
        }, 30000);
        timer.unref();
        try {
          await this.coordinator.refresh({ pullNumber: Number(row.pull_number), waitForConcurrent: true, authoritative: true });
          await this.serviceDatabase.run((db: PostgresJsDatabase) => db.execute(sql`UPDATE ${githubSyncRequest}
            SET completed_generation=claimed_generation,state=CASE WHEN requested_generation>claimed_generation THEN 'pending' ELSE 'done' END,
              attempts=0,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,_updated_at=CURRENT_TIMESTAMP
            WHERE id=${row.id}::uuid AND lease_token=${token}::uuid AND lease_expires_at>CURRENT_TIMESTAMP`));
        } catch {
          await this.serviceDatabase.run((db: PostgresJsDatabase) => db.execute(sql`UPDATE ${githubSyncRequest}
            SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry_wait' END,
              available_at=CURRENT_TIMESTAMP+make_interval(secs=>${Math.min(900,30*2**Number(row.attempts))}),
              lease_token=NULL,lease_expires_at=NULL,last_error_code='github_sync_failed',_updated_at=CURRENT_TIMESTAMP
            WHERE id=${row.id}::uuid AND lease_token=${token}::uuid`));
          throw new Error('GitHub 增量同步暂未完成');
        } finally { clearInterval(timer); await renewal; }
      });
    } finally { this.running = false; }
  }
}
