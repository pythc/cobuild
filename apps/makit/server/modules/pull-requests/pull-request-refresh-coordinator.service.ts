import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { pullRequestSnapshot } from '../../database/schema';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import {
  GitHubPullRequestsService,
  type GitHubPullRequestSnapshot,
} from './github-pull-requests.service';

const REFRESH_LEASE_SECONDS: number = 120;
const REFRESH_HEARTBEAT_MS: number = 30_000;
const REFRESH_COOLDOWN_SECONDS: number = 30;
const CONCURRENT_WAIT_MS: number = 60_000;
const CONCURRENT_POLL_MS: number = 1_000;
// Keep well below PostgreSQL's bind-parameter ceiling as repositories grow,
// while current repositories still complete in a single statement.
const SNAPSHOT_UPSERT_BATCH_SIZE: number = 100;

interface RefreshLeaseRpcRow extends Record<string, unknown> {
  result: Record<string, unknown> | string | null;
}

interface RefreshLeaseStateRow extends Record<string, unknown> {
  active: boolean;
  lease_token: string | null;
  last_succeeded_at: Date | string | null;
}

interface RefreshLeaseClaim {
  claimed: boolean;
  reason: string;
  observedAt: Date | null;
  startedAt: Date | null;
  lastSucceededAt: Date | null;
}

export interface PullRequestRefreshOutcome {
  refreshed: boolean;
  reason: 'refreshed' | 'cooldown' | 'concurrent';
  syncedAt: Date | null;
  syncedCount: number;
}

export interface PullRequestRefreshOptions {
  waitForConcurrent?: boolean;
  cooldownSeconds?: number;
  authoritative?: boolean;
  pullNumber?: number;
}

interface RefreshHeartbeat {
  leaseLost(): boolean;
  stop(): Promise<void>;
}

function optionalDate(value: unknown): Date | null {
  if (!value) return null;
  const parsed: Date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function objectResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve: () => void): void => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Coordinates GitHub snapshot refreshes across every application Pod.
 *
 * Lease operations and snapshot writes are short service-role transactions;
 * GitHub network I/O always happens outside a database transaction. A periodic
 * database-time heartbeat keeps a live refresh leased while a crashed Pod's
 * lease expires automatically.
 */
@Injectable()
export class PullRequestRefreshCoordinatorService {
  private readonly logger: Logger = new Logger(
    PullRequestRefreshCoordinatorService.name,
  );

  constructor(
    private readonly github: GitHubPullRequestsService,
    private readonly serviceRoleDatabase: ServiceRoleDatabaseExecutor,
  ) {}

  async refresh(
    options: PullRequestRefreshOptions = {},
  ): Promise<PullRequestRefreshOutcome> {
    const repository: string = this.github.repository();
    const token: string = randomUUID();
    const cooldownSeconds: number = options.pullNumber ? 0 : options.cooldownSeconds ?? REFRESH_COOLDOWN_SECONDS;
    if (options.pullNumber !== undefined && (!Number.isSafeInteger(options.pullNumber) || options.pullNumber <= 0)) throw new ServiceUnavailableException('合并请求编号无效');
    // A different PR's repository-wide cooldown never proves this target is current.
    if (options.pullNumber) options = { ...options, authoritative: true, waitForConcurrent: true };
    if (
      !Number.isInteger(cooldownSeconds) ||
      cooldownSeconds < 0 ||
      cooldownSeconds > 300
    ) {
      throw new ServiceUnavailableException('合并请求刷新冷却参数无效');
    }
    let claim: RefreshLeaseClaim = await this.claim(
      repository,
      token,
      cooldownSeconds,
    );
    if (
      !claim.claimed &&
      (claim.reason === 'active' || options.authoritative)
    ) {
      if (!options.waitForConcurrent && !options.authoritative) {
        return {
          refreshed: false,
          reason: 'concurrent',
          syncedAt: claim.lastSucceededAt,
          syncedCount: 0,
        };
      }
      claim = await this.waitForConcurrentRefresh(
        repository,
        token,
        options.authoritative ? claim.observedAt : claim.lastSucceededAt,
        cooldownSeconds,
        !options.authoritative,
      );
    }
    if (!claim.claimed) {
      return {
        refreshed: false,
        reason: claim.reason === 'active' ? 'concurrent' : 'cooldown',
        syncedAt: claim.lastSucceededAt,
        syncedCount: 0,
      };
    }
    if (!claim.startedAt) {
      throw new ServiceUnavailableException('合并请求刷新租约时间无效');
    }

    const heartbeat: RefreshHeartbeat = this.startHeartbeat(
      repository,
      token,
      cooldownSeconds,
    );

    try {
      const snapshots: GitHubPullRequestSnapshot[] = options.pullNumber
        ? [await this.github.fetchPullRequest(options.pullNumber)] : await this.github.fetchPullRequests();
      await heartbeat.stop();
      const renewed: RefreshLeaseClaim = await this.claim(
        repository,
        token,
        cooldownSeconds,
      );
      if (
        heartbeat.leaseLost() ||
        !renewed.claimed ||
        renewed.reason !== 'renewed'
      ) {
        throw new ConflictException(
          '合并请求刷新租约已失效，已丢弃本次 GitHub 结果',
        );
      }
      const completedAt: Date = await this.completeAndPersist(
        repository,
        token,
        snapshots,
        claim.startedAt,
      );
      return {
        refreshed: true,
        reason: 'refreshed',
        syncedAt: completedAt,
        syncedCount: snapshots.length,
      };
    } catch (error) {
      await heartbeat.stop();
      await this.finish(repository, token, false).catch(
        (finishError: unknown): void => {
          this.logger.warn(
            `GitHub 快照刷新失败后释放租约失败：${
              finishError instanceof Error
                ? finishError.message
                : String(finishError)
            }`,
          );
        },
      );
      throw error;
    }
  }

  private startHeartbeat(
    repository: string,
    token: string,
    cooldownSeconds: number,
  ): RefreshHeartbeat {
    let activeRenewal: Promise<void> | null = null;
    let lost: boolean = false;
    const renew = async (): Promise<void> => {
      try {
        const renewed: RefreshLeaseClaim = await this.claim(
          repository,
          token,
          cooldownSeconds,
        );
        if (!renewed.claimed || renewed.reason !== 'renewed') lost = true;
      } catch (error) {
        this.logger.warn(
          `GitHub 快照刷新租约续期失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    const timer: ReturnType<typeof setInterval> = setInterval((): void => {
      if (activeRenewal || lost) return;
      activeRenewal = renew().finally((): void => {
        activeRenewal = null;
      });
    }, REFRESH_HEARTBEAT_MS);
    timer.unref();
    return {
      leaseLost: (): boolean => lost,
      stop: async (): Promise<void> => {
        clearInterval(timer);
        await activeRenewal;
      },
    };
  }

  private async claim(
    repository: string,
    token: string,
    cooldownSeconds: number,
  ): Promise<RefreshLeaseClaim> {
    const rows = await this.serviceRoleDatabase.run(
      (database: PostgresJsDatabase) =>
        database.execute<RefreshLeaseRpcRow>(sql`
          SELECT pull_request_refresh_lease_claim_v1(
            ${repository}::text,
            ${token}::uuid,
            ${REFRESH_LEASE_SECONDS}::integer,
            ${cooldownSeconds}::integer
          ) AS result
        `),
    );
    const result: Record<string, unknown> = objectResult(rows[0]?.result);
    return {
      claimed: result.claimed === true,
      reason: String(result.reason || ''),
      observedAt: optionalDate(result.observedAt),
      startedAt: optionalDate(result.startedAt),
      lastSucceededAt: optionalDate(result.lastSucceededAt),
    };
  }

  private async finish(
    repository: string,
    token: string,
    succeeded: boolean,
    database?: PostgresJsDatabase,
  ): Promise<Record<string, unknown>> {
    const execute = async (
      target: PostgresJsDatabase,
    ): Promise<Record<string, unknown>> => {
      const rows = await target.execute<RefreshLeaseRpcRow>(sql`
        SELECT pull_request_refresh_lease_finish_v1(
          ${repository}::text,
          ${token}::uuid,
          ${succeeded}::boolean
        ) AS result
      `);
      return objectResult(rows[0]?.result);
    };
    return database ? execute(database) : this.serviceRoleDatabase.run(execute);
  }

  private async state(
    repository: string,
  ): Promise<RefreshLeaseStateRow | null> {
    const rows = await this.serviceRoleDatabase.run(
      (database: PostgresJsDatabase) =>
        database.execute<RefreshLeaseStateRow>(sql`
          SELECT
            lease_token,
            last_succeeded_at,
            COALESCE(lease_expires_at > clock_timestamp(), false) AS active
          FROM pull_request_refresh_lease
          WHERE repository = ${repository}::text
          LIMIT 1
        `),
    );
    return rows[0] || null;
  }

  private async waitForConcurrentRefresh(
    repository: string,
    token: string,
    freshnessFloor: Date | null,
    cooldownSeconds: number,
    acceptConcurrentSuccess: boolean,
  ): Promise<RefreshLeaseClaim> {
    const deadline: number = Date.now() + CONCURRENT_WAIT_MS;
    while (Date.now() < deadline) {
      await delay(CONCURRENT_POLL_MS);
      const state: RefreshLeaseStateRow | null = await this.state(repository);
      const succeededAt: Date | null = optionalDate(state?.last_succeeded_at);
      if (
        acceptConcurrentSuccess &&
        succeededAt &&
        (!freshnessFloor || succeededAt.getTime() >= freshnessFloor.getTime())
      ) {
        return {
          claimed: false,
          reason: 'cooldown',
          observedAt: succeededAt,
          startedAt: null,
          lastSucceededAt: succeededAt,
        };
      }
      if (!state?.active) {
        const next: RefreshLeaseClaim = await this.claim(
          repository,
          token,
          cooldownSeconds,
        );
        if (next.claimed) return next;
        if (acceptConcurrentSuccess && next.reason !== 'active') return next;
      }
    }
    throw new ServiceUnavailableException(
      '合并请求正在由其他实例刷新，请稍后重试',
    );
  }

  private async completeAndPersist(
    repository: string,
    token: string,
    snapshots: GitHubPullRequestSnapshot[],
    reviewersFetchedAt: Date,
  ): Promise<Date> {
    return this.serviceRoleDatabase.run(
      async (database: PostgresJsDatabase): Promise<Date> => {
        const completion: Record<string, unknown> = await this.finish(
          repository,
          token,
          true,
          database,
        );
        if (completion.finished !== true) {
          throw new ConflictException(
            '合并请求刷新租约已失效，已丢弃本次 GitHub 结果',
          );
        }
        const completedAt: Date | null = optionalDate(completion.completedAt);
        if (!completedAt) {
          throw new ServiceUnavailableException('合并请求同步时间无效');
        }
        await this.upsertSnapshots(
          database,
          snapshots,
          completedAt,
          reviewersFetchedAt,
        );
        return completedAt;
      },
    );
  }

  private async upsertSnapshots(
    database: PostgresJsDatabase,
    snapshots: GitHubPullRequestSnapshot[],
    syncedAt: Date,
    reviewersFetchedAt: Date,
  ): Promise<void> {
    if (!snapshots.length) return;
    for (
      let offset: number = 0;
      offset < snapshots.length;
      offset += SNAPSHOT_UPSERT_BATCH_SIZE
    ) {
      const batch: GitHubPullRequestSnapshot[] = snapshots.slice(
        offset,
        offset + SNAPSHOT_UPSERT_BATCH_SIZE,
      );
      const statement = database
        .insert(pullRequestSnapshot)
        .values(
          batch.map((snapshot: GitHubPullRequestSnapshot) => ({
            repository: snapshot.repository,
            pullNumber: snapshot.number,
            title: snapshot.title,
            body: snapshot.body,
            state: snapshot.state,
            draft: snapshot.draft,
            url: snapshot.url,
            authorLogin: snapshot.author.login,
            authorAvatarUrl: snapshot.author.avatarUrl,
            headRef: snapshot.headRef,
            baseRef: snapshot.baseRef,
            mergeable: snapshot.mergeable,
            reviewDecision: snapshot.reviewDecision,
            checksStatus: snapshot.checksStatus,
            additions: snapshot.additions,
            deletions: snapshot.deletions,
            changedFiles: snapshot.changedFiles,
            commitCount: snapshot.commitCount,
            commentCount: snapshot.commentCount,
            reviewCount: snapshot.reviewCount,
            reviewThreadCount: snapshot.reviewThreadCount,
            commentsJson: JSON.stringify(snapshot.comments),
            reviewsJson: JSON.stringify(snapshot.reviews),
            requestedReviewersJson: JSON.stringify(snapshot.requestedReviewers),
            reviewersUpdatedAt: reviewersFetchedAt,
            reviewThreadsJson: JSON.stringify(snapshot.reviewThreads),
            checksJson: JSON.stringify(snapshot.checks),
            githubCreatedAt: optionalDate(snapshot.createdAt),
            githubUpdatedAt: new Date(snapshot.updatedAt),
            closedAt: optionalDate(snapshot.closedAt),
            mergedAt: optionalDate(snapshot.mergedAt),
            syncedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [
            pullRequestSnapshot.repository,
            pullRequestSnapshot.pullNumber,
          ],
          set: {
            title: sql`excluded.title`,
            body: sql`excluded.body`,
            state: sql`excluded.state`,
            draft: sql`excluded.draft`,
            url: sql`excluded.url`,
            authorLogin: sql`excluded.author_login`,
            authorAvatarUrl: sql`excluded.author_avatar_url`,
            headRef: sql`excluded.head_ref`,
            baseRef: sql`excluded.base_ref`,
            mergeable: sql`excluded.mergeable`,
            reviewDecision: sql`excluded.review_decision`,
            checksStatus: sql`excluded.checks_status`,
            additions: sql`excluded.additions`,
            deletions: sql`excluded.deletions`,
            changedFiles: sql`excluded.changed_files`,
            commitCount: sql`excluded.commit_count`,
            commentCount: sql`excluded.comment_count`,
            reviewCount: sql`excluded.review_count`,
            reviewThreadCount: sql`excluded.review_thread_count`,
            commentsJson: sql`excluded.comments_json`,
            reviewsJson: sql`excluded.reviews_json`,
            requestedReviewersJson: sql`CASE
            WHEN ${pullRequestSnapshot.reviewersUpdatedAt} < excluded.reviewers_updated_at
              THEN excluded.requested_reviewers_json
            ELSE ${pullRequestSnapshot.requestedReviewersJson}
          END`,
            reviewersUpdatedAt: sql`GREATEST(
            ${pullRequestSnapshot.reviewersUpdatedAt},
            excluded.reviewers_updated_at
          )`,
            reviewThreadsJson: sql`excluded.review_threads_json`,
            checksJson: sql`excluded.checks_json`,
            githubCreatedAt: sql`excluded.github_created_at`,
            githubUpdatedAt: sql`excluded.github_updated_at`,
            closedAt: sql`excluded.closed_at`,
            mergedAt: sql`excluded.merged_at`,
            syncedAt: sql`excluded.synced_at`,
            updatedAt: sql`excluded.synced_at`,
          },
        });
      await database.execute(statement);
    }
  }
}
