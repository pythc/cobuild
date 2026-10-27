import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  GitHubActorSummary,
  GitHubReviewerCandidate,
  PullRequestCheckSummary,
  PullRequestCommentSummary,
  PullRequestDetailResponse,
  PullRequestRefreshResult,
  PullRequestReviewerBindingInput,
  PullRequestReviewerUpdateResult,
  PullRequestReviewSummary,
  PullRequestReviewThreadSummary,
  PullRequestSummary,
  PullRequestWorkspaceResponse,
  RequirementSummary,
  CurrentUserSummary,
  WorkspaceResponse,
} from '@shared/api.interface';
import { pullRequestSnapshot } from '../../database/schema';
import {
  FeishuService,
  FeishuMessageDeliveryError,
} from '../requirements/feishu.service';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { deliveryPolicy } from '../notifications/notification-delivery.model';
import { RequirementAccessService } from '../requirements/requirement-access.service';
import type { McpWriteProof } from '../requirements/mcp-auth.types';
import { pullRequestPlatformUrl } from '../requirements/requirement-links';
import { RequirementsQueryService } from '../requirements/requirements-query.service';
import {
  GitHubPullRequestsService,
  type GitHubReviewerMutation,
} from './github-pull-requests.service';
import {
  PullRequestRefreshCoordinatorService,
  type PullRequestRefreshOutcome,
} from './pull-request-refresh-coordinator.service';
import {
  linkedRequirementsForPullRequest,
  parseJsonArray,
  pullRequestStats,
  uniqueUserIds,
} from './pull-requests.model';
import { reviewerNotificationPolicyConfig } from './reviewer-notification-policy';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';

type ReviewerNotificationSnapshot = Pick<
  SnapshotRecord,
  'title' | 'headRef' | 'baseRef' | 'pullNumber'
>;

interface RequestIdentity {
  userId: string;
  userName: string;
  roles?: string[];
  employeeId?: string;
  openId?: string;
  mcpWriteProof?: McpWriteProof;
}

type SnapshotRecord = typeof pullRequestSnapshot.$inferSelect;

interface ReviewerRecord {
  id: string;
  repository: string;
  pullNumber: number;
  githubLogin: string;
  reviewerEmployeeId: string;
  reviewerName: string;
  assignedByName: string;
  assignedByUserId: string;
  deliveryEligible: boolean;
  suppressedAt: Date | null;
  notificationClaimToken: string | null;
}

interface ReviewerBindingRecord {
  id: string;
  repository: string;
  githubLogin: string;
  reviewerEmployeeId: string;
  reviewerName: string;
}

const STALE_AFTER_MS: number = 30 * 60 * 1000;
const NOTIFICATION_RETRY_MS: number = 60_000;
const MAX_NOTIFICATION_ATTEMPTS: number = 8;
const NOTIFICATION_BATCH_SIZE: number = 20;
const NOTIFICATION_LEASE_SECONDS: number = 120;
const RECONCILIATION_BATCH_SIZE: number = 4;
const RECONCILIATION_LEASE_SECONDS: number = 120;

interface ReconciledNotificationRow extends Record<string, unknown> {
  assignment_id: string;
  delivery_eligible: boolean;
}

interface PreparedReviewerOperationRow extends Record<string, unknown> {
  operation_token: string;
  operation_generation: number;
  operation_reused: boolean;
}

interface PreparedReviewerOperation {
  token: string;
  reused: boolean;
}

interface ReviewerReconciliationClaimRow extends Record<string, unknown> {
  pull_number: number;
  operation_generation: number;
  reconciliation_claim_token: string;
}

interface ReviewerBindingRow extends Record<string, unknown> {
  binding_id: string;
  github_login: string;
  reviewer_employee_id: string;
  reviewer_name: string;
}

interface ReviewerEventRow extends Record<string, unknown> {
  assignment_id: string;
  repository: string;
  pull_number: number;
  github_login: string;
  reviewer_employee_id: string;
  reviewer_name: string;
  assigned_by_name: string;
  assigned_by_user_id: string;
  delivery_eligible: boolean;
  suppressed_at: Date | string | null;
  notification_claim_token: string | null;
}

interface NotificationResultRow extends Record<string, unknown> {
  result: { affectedCount?: number; success?: boolean } | string | null;
}

@Injectable()
export class PullRequestsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger: Logger = new Logger(PullRequestsService.name);
  private syncRequest: Promise<PullRequestRefreshResult> | null = null;
  private notificationTimer: ReturnType<typeof setInterval> | null = null;
  private notificationDispatching: boolean = false;

  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly github: GitHubPullRequestsService,
    private readonly requirements: RequirementsQueryService,
    private readonly feishu: FeishuService,
    private readonly requirementAccess: RequirementAccessService,
    private readonly serviceRoleDatabase: ServiceRoleDatabaseExecutor,
    private readonly refreshCoordinator?: PullRequestRefreshCoordinatorService,
    private readonly deliveries?: NotificationDeliveryService,
  ) {}

  private async assertCanUpdateReviewers(
    _row: SnapshotRecord,
    identity: RequestIdentity,
  ): Promise<void> {
    const resolvedUser: CurrentUserSummary =
      identity.employeeId && identity.openId
        ? {
            miaodaUserId: identity.userId,
            employeeId: identity.employeeId,
            openId: identity.openId,
            name: identity.userName,
            platformRoleIds: identity.roles || [],
          }
        : await this.requirements.currentUser(identity);
    const actor: CurrentUserSummary = {
      ...resolvedUser,
      employeeId: identity.employeeId || resolvedUser.employeeId,
      openId: identity.openId || resolvedUser.openId,
      platformRoleIds:
        identity.roles ||
        resolvedUser.platformRoleIds ||
        resolvedUser.roles ||
        [],
    };
    this.requirementAccess.assertCanCreate(actor);
  }

  private async assertCanRefresh(identity: RequestIdentity): Promise<void> {
    const resolvedUser: CurrentUserSummary =
      identity.employeeId && identity.openId
        ? {
            miaodaUserId: identity.userId,
            employeeId: identity.employeeId,
            openId: identity.openId,
            name: identity.userName,
            platformRoleIds: identity.roles || [],
          }
        : await this.requirements.currentUser(identity);
    const actor: CurrentUserSummary = {
      ...resolvedUser,
      platformRoleIds:
        identity.roles ||
        resolvedUser.platformRoleIds ||
        resolvedUser.roles ||
        [],
    };
    this.requirementAccess.assertCanCreate(actor);
  }

  onModuleInit(): void {
    if (process.env.MAKIT_WORKERS_ENABLED === 'false') return;
    setTimeout((): void => this.dispatchPendingNotifications(), 0);
    this.notificationTimer = setInterval(
      (): void => this.dispatchPendingNotifications(),
      NOTIFICATION_RETRY_MS,
    );
    this.notificationTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.notificationTimer) clearInterval(this.notificationTimer);
  }

  private async refreshRepository(
    waitForConcurrent: boolean = true,
  ): Promise<PullRequestRefreshResult> {
    if (this.syncRequest) return this.syncRequest;
    const request: Promise<PullRequestRefreshResult> = (async () => {
      if (!this.refreshCoordinator) {
        throw new ServiceUnavailableException('合并请求刷新服务尚未就绪');
      }
      const outcome: PullRequestRefreshOutcome =
        await this.refreshCoordinator.refresh({ waitForConcurrent });
      return {
        success: true,
        message: outcome.refreshed
          ? `已更新 ${outcome.syncedCount} 个合并请求`
          : outcome.reason === 'concurrent'
            ? '合并请求正在由其他实例更新'
            : '合并请求刚刚已更新',
        syncedCount: outcome.syncedCount,
        syncedAt: outcome.syncedAt?.toISOString() || new Date(0).toISOString(),
      };
    })();
    this.syncRequest = request;
    try {
      return await request;
    } finally {
      if (this.syncRequest === request) this.syncRequest = null;
    }
  }

  async refresh(identity: RequestIdentity): Promise<PullRequestRefreshResult> {
    await this.assertCanRefresh(identity);
    return this.refreshRepository(true);
  }

  async refreshPullRequest(
    pullNumber: number,
    identity?: RequestIdentity,
  ): Promise<PullRequestRefreshResult> {
    if (identity) await this.assertCanRefresh(identity);
    if (!this.refreshCoordinator)
      throw new ServiceUnavailableException('合并请求刷新服务尚未就绪');
    const outcome = await this.refreshCoordinator.refresh({
      pullNumber,
      authoritative: true,
      waitForConcurrent: true,
    });
    return {
      success: outcome.refreshed,
      message: '已更新合并请求',
      syncedCount: outcome.syncedCount,
      syncedAt: outcome.syncedAt?.toISOString() || new Date(0).toISOString(),
    };
  }

  private async reconcilePendingReviewerNotifications(): Promise<void> {
    const claims = await this.serviceRoleDatabase.run(
      (database: PostgresJsDatabase) =>
        database.execute<ReviewerReconciliationClaimRow>(sql`
          SELECT pull_number, operation_generation,
            reconciliation_claim_token
          FROM pull_request_reviewer_state_reconciliation_claim(
            ${this.github.repository()}::text,
            ${RECONCILIATION_BATCH_SIZE}::integer,
            ${RECONCILIATION_LEASE_SECONDS}::integer
          )
        `),
    );
    await Promise.all(
      claims.map(
        async (claim: ReviewerReconciliationClaimRow): Promise<void> => {
          try {
            const reviewers: GitHubActorSummary[] =
              await this.github.currentRequestedReviewers(claim.pull_number);
            await this.serviceRoleDatabase.run((database: PostgresJsDatabase) =>
              this.finalizeReviewerNotificationState(
                this.github.repository(),
                claim.pull_number,
                reviewers,
                null,
                claim.reconciliation_claim_token,
                Number(claim.operation_generation),
                undefined,
                undefined,
                database,
              ),
            );
          } catch (error) {
            this.logger.warn(
              `补偿合并请求 #${claim.pull_number} 评审通知失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        },
      ),
    );
  }

  private async snapshots(): Promise<SnapshotRecord[]> {
    return this.db
      .select()
      .from(pullRequestSnapshot)
      .where(eq(pullRequestSnapshot.repository, this.github.repository()))
      .orderBy(desc(pullRequestSnapshot.githubUpdatedAt));
  }

  private summary(
    row: SnapshotRecord,
    requirements: RequirementSummary[],
  ): PullRequestSummary {
    const linkedRequirements = linkedRequirementsForPullRequest(
      {
        title: row.title,
        body: row.body,
        headRef: row.headRef,
        url: row.url,
      },
      requirements,
    );
    return {
      repository: row.repository,
      number: row.pullNumber,
      title: row.title,
      body: row.body,
      state: row.state as 'OPEN' | 'MERGED' | 'CLOSED',
      draft: row.draft,
      url: row.url,
      author: {
        login: row.authorLogin,
        avatarUrl: row.authorAvatarUrl,
      },
      headRef: row.headRef,
      baseRef: row.baseRef,
      mergeable: row.mergeable,
      reviewDecision: row.reviewDecision,
      checksStatus: row.checksStatus,
      additions: row.additions,
      deletions: row.deletions,
      changedFiles: row.changedFiles,
      commitCount: row.commitCount,
      commentCount: row.commentCount,
      reviewCount: row.reviewCount,
      reviewThreadCount: row.reviewThreadCount,
      createdAt: row.githubCreatedAt?.toISOString() || null,
      updatedAt: row.githubUpdatedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() || null,
      mergedAt: row.mergedAt?.toISOString() || null,
      syncedAt: row.syncedAt.toISOString(),
      linkedRequirements,
      linkedIterationIds: [
        ...new Set(
          linkedRequirements.flatMap((requirement) => requirement.iterationIds),
        ),
      ],
      linkedIterationNames: [
        ...new Set(
          linkedRequirements.flatMap(
            (requirement) => requirement.iterationNames,
          ),
        ),
      ],
      requestedReviewers: parseJsonArray<GitHubActorSummary>(
        row.requestedReviewersJson,
      ),
    };
  }

  private async reviewerBindingMap(
    identity?: RequestIdentity,
    mcpProof?: McpWriteProof,
  ): Promise<Map<string, ReviewerBindingRecord>> {
    const repository: string = this.github.repository();
    const rows = await this.db.execute<ReviewerBindingRow>(sql`
      SELECT binding_id, github_login, reviewer_employee_id, reviewer_name
      FROM github_reviewer_bindings_get(
        ${repository}::text,
        ${identity?.userId || null}::text,
        ${mcpProof?.credentialId || null}::uuid,
        ${mcpProof?.tokenVersion || null}::integer,
        ${mcpProof?.subjectHash || null}::varchar
      )
    `);
    return new Map(
      rows.map((row: ReviewerBindingRow): [string, ReviewerBindingRecord] => {
        const binding: ReviewerBindingRecord = {
          id: row.binding_id,
          repository,
          githubLogin: row.github_login,
          reviewerEmployeeId: row.reviewer_employee_id,
          reviewerName: row.reviewer_name,
        };
        return [binding.githubLogin.toLowerCase(), binding];
      }),
    );
  }

  private async reviewerCandidates(
    identity?: RequestIdentity,
    mcpProof?: McpWriteProof,
  ): Promise<GitHubReviewerCandidate[]> {
    const [candidates, bindings]: [
      GitHubActorSummary[],
      Map<string, ReviewerBindingRecord>,
    ] = await Promise.all([
      this.github.reviewerCandidates(),
      this.reviewerBindingMap(identity, mcpProof),
    ]);
    return candidates.map(
      (candidate: GitHubActorSummary): GitHubReviewerCandidate => {
        const binding: ReviewerBindingRecord | undefined = bindings.get(
          candidate.login.toLowerCase(),
        );
        return {
          ...candidate,
          feishuEmployeeId: binding?.reviewerEmployeeId || '',
          feishuName: binding?.reviewerName || '',
        };
      },
    );
  }

  async workspace(
    identity: RequestIdentity,
    forceRefresh: boolean = false,
  ): Promise<PullRequestWorkspaceResponse> {
    let rows: SnapshotRecord[] = await this.snapshots();
    let syncWarning: string = '';
    if (forceRefresh || rows.length === 0) {
      try {
        if (forceRefresh) await this.assertCanRefresh(identity);
        await this.refreshRepository(true);
        rows = await this.snapshots();
      } catch (error) {
        if (!rows.length) throw error;
        syncWarning =
          error instanceof Error ? error.message : 'GitHub 同步暂时不可用';
      }
    }
    const latestSync: Date | null = rows[0]?.syncedAt || null;
    const stale: boolean =
      !latestSync || Date.now() - latestSync.getTime() > STALE_AFTER_MS;
    if (stale && !forceRefresh && rows.length) {
      void this.refreshRepository(false).catch((error: unknown): void => {
        this.logger.warn(
          `后台刷新合并请求失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    const [workspace, reviewerCandidates]: [
      WorkspaceResponse,
      GitHubReviewerCandidate[],
    ] = await Promise.all([
      this.requirements.workspace(identity, false),
      this.reviewerCandidates(identity, identity.mcpWriteProof),
    ]);
    const pullRequests: PullRequestSummary[] = rows.map(
      (row: SnapshotRecord): PullRequestSummary =>
        this.summary(row, workspace.requirements),
    );
    return {
      repository: this.github.repository(),
      fetchedAt: new Date().toISOString(),
      syncedAt: latestSync?.toISOString() || null,
      stale,
      syncWarning,
      stats: pullRequestStats(pullRequests),
      iterations: workspace.iterations,
      reviewerCandidates,
      pullRequests,
    };
  }

  async detail(
    pullNumber: number,
    identity: RequestIdentity,
  ): Promise<PullRequestDetailResponse> {
    let [row]: SnapshotRecord[] = await this.db
      .select()
      .from(pullRequestSnapshot)
      .where(
        and(
          eq(pullRequestSnapshot.repository, this.github.repository()),
          eq(pullRequestSnapshot.pullNumber, pullNumber),
        ),
      )
      .limit(1);
    if (!row) {
      await this.refreshPullRequest(pullNumber);
      [row] = await this.db
        .select()
        .from(pullRequestSnapshot)
        .where(
          and(
            eq(pullRequestSnapshot.repository, this.github.repository()),
            eq(pullRequestSnapshot.pullNumber, pullNumber),
          ),
        )
        .limit(1);
    }
    if (!row) throw new NotFoundException('未找到该合并请求');
    const [requirementsWorkspace, reviewerCandidates]: [
      WorkspaceResponse,
      GitHubReviewerCandidate[],
    ] = await Promise.all([
      this.requirements.workspace(identity, false),
      this.reviewerCandidates(identity, identity.mcpWriteProof),
    ]);
    const pullRequest: PullRequestSummary = this.summary(
      row,
      requirementsWorkspace.requirements,
    );
    const comments: PullRequestCommentSummary[] =
      parseJsonArray<PullRequestCommentSummary>(row.commentsJson);
    const reviews: PullRequestReviewSummary[] =
      parseJsonArray<PullRequestReviewSummary>(row.reviewsJson);
    const reviewThreads: PullRequestReviewThreadSummary[] =
      parseJsonArray<PullRequestReviewThreadSummary>(row.reviewThreadsJson);
    return {
      pullRequest,
      canManageReviewers: ['admin', 'editor'].includes(
        requirementsWorkspace.currentUser.accessLevel || '',
      ),
      reviewerCandidates,
      comments,
      completeness: {
        comments: {
          loadedCount: comments.length,
          totalCount: pullRequest.commentCount,
          complete: comments.length >= pullRequest.commentCount,
        },
        reviews: {
          loadedCount: reviews.length,
          totalCount: pullRequest.reviewCount,
          complete: reviews.length >= pullRequest.reviewCount,
        },
        reviewThreads: {
          loadedCount: reviewThreads.length,
          totalCount: pullRequest.reviewThreadCount,
          complete: reviewThreads.length >= pullRequest.reviewThreadCount,
        },
      },
      reviews,
      reviewThreads,
      checks: parseJsonArray<PullRequestCheckSummary>(row.checksJson),
      // Delivery attempts and provider errors belong to the admin-only
      // notification center. PR collaboration APIs intentionally omit them.
      reviewerNotifications: [],
    };
  }

  async forRequirement(
    recordId: string,
    identity: RequestIdentity,
  ): Promise<PullRequestSummary[]> {
    const [requirement, rows]: [RequirementSummary, SnapshotRecord[]] =
      await Promise.all([
        this.requirements.requirementById(recordId, identity),
        this.snapshots(),
      ]);
    return rows
      .map(
        (row: SnapshotRecord): PullRequestSummary =>
          this.summary(row, [requirement]),
      )
      .filter(
        (pullRequest: PullRequestSummary): boolean =>
          pullRequest.linkedRequirements.length > 0,
      );
  }

  private async upsertReviewerBindings(
    desiredLogins: string[],
    bindings: PullRequestReviewerBindingInput[],
    identity: RequestIdentity,
    mcpProof?: McpWriteProof,
  ): Promise<Map<string, ReviewerBindingRecord>> {
    const repository: string = this.github.repository();
    const desired: Set<string> = new Set(
      desiredLogins.map((login: string): string => login.toLowerCase()),
    );
    const normalizedBindings: PullRequestReviewerBindingInput[] = bindings.map(
      (binding: PullRequestReviewerBindingInput) => ({
        login: binding.login.trim().toLowerCase(),
        feishuEmployeeId: binding.feishuEmployeeId.trim(),
      }),
    );
    if (
      new Set(normalizedBindings.map((binding) => binding.login)).size !==
      normalizedBindings.length
    ) {
      throw new BadRequestException('同一 GitHub 账号不能重复绑定');
    }
    const invalid: PullRequestReviewerBindingInput | undefined =
      normalizedBindings.find(
        (binding: PullRequestReviewerBindingInput): boolean =>
          !binding.login ||
          !binding.feishuEmployeeId ||
          !desired.has(binding.login),
      );
    if (invalid) {
      throw new BadRequestException('飞书成员绑定与所选 GitHub 账号不一致');
    }

    const current: Map<string, ReviewerBindingRecord> =
      await this.reviewerBindingMap(identity, mcpProof);
    const employeeOwner: Map<string, string> = new Map(
      [...current.entries()].map(
        ([login, row]: [string, ReviewerBindingRecord]): [string, string] => [
          row.reviewerEmployeeId,
          login,
        ],
      ),
    );
    for (const binding of normalizedBindings) {
      const owner: string | undefined = employeeOwner.get(
        binding.feishuEmployeeId,
      );
      if (owner && owner !== binding.login) {
        throw new BadRequestException(`该飞书成员已绑定 GitHub 账号 ${owner}`);
      }
      const previous: ReviewerBindingRecord | undefined = current.get(
        binding.login,
      );
      if (previous) employeeOwner.delete(previous.reviewerEmployeeId);
      employeeOwner.set(binding.feishuEmployeeId, binding.login);
    }

    if (normalizedBindings.length) {
      const resolved = await Promise.all(
        normalizedBindings.map(
          async (binding: PullRequestReviewerBindingInput) => ({
            binding,
            user: await this.feishu.getUserByEmployeeId(
              binding.feishuEmployeeId,
            ),
          }),
        ),
      );
      const payload = resolved.map(({ binding, user }) => ({
        login: binding.login,
        employeeId: binding.feishuEmployeeId,
        name: user.name,
      }));
      await this.db.execute(sql`
        SELECT github_reviewer_bindings_upsert(
          ${repository}::text,
          ${JSON.stringify(payload)}::jsonb,
          ${identity.userId}::text,
          ${mcpProof?.credentialId || null}::uuid,
          ${mcpProof?.tokenVersion || null}::integer,
          ${mcpProof?.subjectHash || null}::varchar
        )
      `);
    }

    const saved: Map<string, ReviewerBindingRecord> =
      await this.reviewerBindingMap(identity, mcpProof);
    const missing: string[] = desiredLogins.filter(
      (login: string): boolean => !saved.has(login.toLowerCase()),
    );
    if (missing.length) {
      throw new BadRequestException(
        `请先为以下 GitHub 账号选择飞书成员：${missing.join('、')}`,
      );
    }
    const selectedEmployees: string[] = desiredLogins.map(
      (login: string): string =>
        saved.get(login.toLowerCase())?.reviewerEmployeeId || '',
    );
    if (new Set(selectedEmployees).size !== selectedEmployees.length) {
      throw new BadRequestException('一个飞书成员只能对应一个 GitHub 评审账号');
    }
    return saved;
  }

  async updateReviewers(
    pullNumber: number,
    reviewerLogins: string[],
    identity: RequestIdentity,
    reviewerBindings: PullRequestReviewerBindingInput[] = [],
    mcpProof?: McpWriteProof,
  ): Promise<PullRequestReviewerUpdateResult> {
    if (reviewerLogins.length > 100) {
      throw new BadRequestException('GitHub 评审人不能超过 100 位');
    }
    const [row]: SnapshotRecord[] = await this.db
      .select()
      .from(pullRequestSnapshot)
      .where(
        and(
          eq(pullRequestSnapshot.repository, this.github.repository()),
          eq(pullRequestSnapshot.pullNumber, pullNumber),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('未找到该合并请求');
    if (row.state !== 'OPEN') {
      throw new BadRequestException('只能设置进行中的合并请求评审人');
    }
    await this.assertCanUpdateReviewers(row, identity);

    const candidates: GitHubActorSummary[] =
      await this.github.reviewerCandidates();
    const candidateMap: Map<string, GitHubActorSummary> = new Map(
      candidates.map(
        (candidate: GitHubActorSummary): [string, GitHubActorSummary] => [
          candidate.login.toLowerCase(),
          candidate,
        ],
      ),
    );
    const normalizedLogins: string[] = uniqueUserIds(reviewerLogins).map(
      (login: string): string => login.toLowerCase(),
    );
    const unknownLogins: string[] = normalizedLogins.filter(
      (login: string): boolean => !candidateMap.has(login),
    );
    if (unknownLogins.length) {
      throw new BadRequestException(
        `以下账号没有仓库写权限：${unknownLogins.join('、')}`,
      );
    }
    if (normalizedLogins.includes(row.authorLogin.toLowerCase())) {
      throw new BadRequestException('不能将合并请求作者设置为评审人');
    }
    const desired: string[] = normalizedLogins.map(
      (login: string): string => candidateMap.get(login)?.login || login,
    );
    const effectiveProof: McpWriteProof | undefined =
      mcpProof || identity.mcpWriteProof;
    await this.upsertReviewerBindings(
      desired,
      reviewerBindings,
      identity,
      effectiveProof,
    );
    // Notification intent is based on GitHub's live state, never a cached
    // snapshot. This prevents historical reviewers from being treated as a
    // new assignment when the local cache is stale.
    const currentReviewers: GitHubActorSummary[] =
      await this.github.currentRequestedReviewers(pullNumber);
    const beforeLogins: string[] = currentReviewers.map(
      (reviewer: GitHubActorSummary): string => reviewer.login,
    );
    const repository: string = this.github.repository();
    const operation: PreparedReviewerOperation =
      await this.prepareReviewerNotificationState(
        repository,
        pullNumber,
        beforeLogins,
        desired,
        identity.userName || '当前用户',
        identity,
        effectiveProof,
      );
    const beforeKey: string = beforeLogins
      .map((login: string): string => login.toLowerCase())
      .sort()
      .join('\n');
    const desiredKey: string = desired
      .map((login: string): string => login.toLowerCase())
      .sort()
      .join('\n');
    if (operation.reused && beforeKey !== desiredKey) {
      throw new ConflictException(
        '相同的评审人变更仍在处理中，请稍后刷新；系统不会重复请求 GitHub',
      );
    }
    // Exact retries whose desired state is already authoritative do not call
    // GitHub again; they only finish the durable outbox transaction.
    const mutation: GitHubReviewerMutation =
      beforeKey === desiredKey
        ? {
            requestedReviewers: currentReviewers,
            addedLogins: [],
            removedLogins: [],
            fullyApplied: true,
            warning: '',
          }
        : await this.github.replaceRequestedReviewers(
            pullNumber,
            desired,
            currentReviewers,
          );

    const mutationQueuedIds: string[] =
      await this.finalizeReviewerNotificationState(
        repository,
        pullNumber,
        mutation.requestedReviewers,
        operation.token,
        null,
        null,
        identity,
        effectiveProof,
      );
    const queuedIds: string[] = [...new Set(mutationQueuedIds)];
    if (queuedIds.length) {
      // Delivery functions are service_role-only. The fast path is best effort;
      // the module-level worker will claim the durable event if request-scoped
      // credentials cannot use the privileged delivery boundary.
      void this.claimNotifications(queuedIds)
        .then(
          async (claimed: ReviewerRecord[]): Promise<void> =>
            void (await this.notifyAssignments(claimed)),
        )
        .catch((error: unknown): void => {
          this.logger.warn(
            `合并请求评审通知已入队，等待后台投递：${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    // A reviewer mutation must not be hidden by the ordinary refresh cooldown.
    // Run a strict follow-up read: if an older refresh is active it finishes
    // first, then this request takes a new lease and reads GitHub again.
    if (this.refreshCoordinator) {
      void this.refreshCoordinator
        .refresh({
          waitForConcurrent: true,
          cooldownSeconds: 0,
          authoritative: true,
        })
        .catch((error: unknown): void => {
          this.logger.warn(
            `GitHub 评审人已更新，但后台刷新 PR 快照失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
    if (!mutation.fullyApplied) {
      throw new ConflictException(
        `${mutation.warning || 'GitHub 只完成了部分评审人变更'}；平台已同步实际结果，请刷新后重试`,
      );
    }
    return {
      success: true,
      message: '已更新评审人',
      reviewerLogins: mutation.requestedReviewers.map(
        (reviewer: GitHubActorSummary): string => reviewer.login,
      ),
      notificationQueuedCount: queuedIds.length,
    };
  }

  private async prepareReviewerNotificationState(
    repository: string,
    pullNumber: number,
    beforeLogins: string[],
    desiredLogins: string[],
    assignedByName: string,
    identity?: RequestIdentity,
    mcpProof?: McpWriteProof,
  ): Promise<PreparedReviewerOperation> {
    const policy = reviewerNotificationPolicyConfig();
    const policySnapshot = {
      mode: policy.mode,
      allowedUserIds: [...policy.allowedUserIds],
    };
    const prepared = await this.db.execute<PreparedReviewerOperationRow>(sql`
      SELECT operation_token, operation_generation, operation_reused
      FROM pull_request_reviewer_state_prepare(
        ${repository}::text,
        ${pullNumber}::integer,
        ${JSON.stringify(beforeLogins)}::jsonb,
        ${JSON.stringify(desiredLogins)}::jsonb,
        ${assignedByName}::text,
        ${JSON.stringify(policySnapshot)}::jsonb,
        ${identity?.userId || null}::text,
        ${mcpProof?.credentialId || null}::uuid,
        ${mcpProof?.tokenVersion || null}::integer,
        ${mcpProof?.subjectHash || null}::varchar
      )
    `);
    const operationToken: string | undefined = prepared[0]?.operation_token;
    if (!operationToken) {
      throw new Error('未能获取 GitHub 评审人变更租约');
    }
    return {
      token: operationToken,
      reused: Boolean(prepared[0]?.operation_reused),
    };
  }

  private async finalizeReviewerNotificationState(
    repository: string,
    pullNumber: number,
    activeReviewers: GitHubActorSummary[],
    operationToken: string | null,
    reconciliationClaimToken: string | null,
    reconciliationGeneration: number | null,
    identity?: RequestIdentity,
    mcpProof?: McpWriteProof,
    database: PostgresJsDatabase = this.db,
  ): Promise<string[]> {
    const reconciled = await database.execute<ReconciledNotificationRow>(sql`
      SELECT assignment_id, delivery_eligible
      FROM pull_request_reviewer_state_finalize(
        ${repository}::text,
        ${pullNumber}::integer,
        ${JSON.stringify(activeReviewers)}::jsonb,
        ${operationToken}::uuid,
        ${reconciliationClaimToken}::uuid,
        ${reconciliationGeneration}::integer,
        ${identity?.userId || null}::text,
        ${mcpProof?.credentialId || null}::uuid,
        ${mcpProof?.tokenVersion || null}::integer,
        ${mcpProof?.subjectHash || null}::varchar
      )
    `);
    const ids: string[] = reconciled.map(
      (row: ReconciledNotificationRow): string =>
        row.delivery_eligible ? row.assignment_id : '',
    );
    return ids.filter(Boolean);
  }

  private reviewerEvents(rows: ReviewerEventRow[]): ReviewerRecord[] {
    return rows.map(
      (row: ReviewerEventRow): ReviewerRecord => ({
        id: row.assignment_id,
        repository: row.repository,
        pullNumber: row.pull_number,
        githubLogin: row.github_login,
        reviewerEmployeeId: row.reviewer_employee_id,
        reviewerName: row.reviewer_name,
        assignedByName: row.assigned_by_name,
        assignedByUserId: row.assigned_by_user_id,
        deliveryEligible: row.delivery_eligible,
        suppressedAt: row.suppressed_at ? new Date(row.suppressed_at) : null,
        notificationClaimToken: row.notification_claim_token,
      }),
    );
  }

  private async notifyReviewer(
    assignment: ReviewerRecord,
    pullRequest: ReviewerNotificationSnapshot,
  ): Promise<boolean> {
    if (!assignment.notificationClaimToken) {
      this.logger.error(`拒绝投递未持有租约的合并请求通知：${assignment.id}`);
      return false;
    }
    if (!assignment.deliveryEligible || assignment.suppressedAt) {
      this.logger.warn(`合并请求评审私聊事件已在入队时抑制：${assignment.id}`);
      return false;
    }
    if (!this.deliveries)
      throw new ServiceUnavailableException('通知台账尚未就绪');
    const lines: string[] = [
      `操作人：${assignment.assignedByName || '需求协作平台用户'}`,
      `仓库：${assignment.repository}`,
      `合并请求：#${assignment.pullNumber} ${pullRequest.title}`,
      `分支：${pullRequest.headRef} → ${pullRequest.baseRef}`,
      `GitHub 账号：${assignment.githubLogin || '未设置'}`,
      '可通过下方链接在需求平台查看该合并请求及关联需求。',
      '请及时完成评审并反馈结论。',
    ];
    const policy = deliveryPolicy(
      'feishu_private',
      assignment.reviewerEmployeeId,
      'pr_reviewer',
    );
    const deliveryId: string = await this.deliveries.record(
      {
        eventId: `pr-reviewer:${assignment.id}`,
        source: 'pr_reviewer',
        owner: 'platform_pr',
        kind: 'reviewer-assigned',
        templateVersion: 'pr-reviewer-v1',
        repository: assignment.repository,
        pullNumber: assignment.pullNumber,
        channel: 'feishu_private',
        targetId: assignment.reviewerEmployeeId,
        targetName: assignment.reviewerName,
        platformUrl: pullRequestPlatformUrl(assignment.pullNumber),
        policyMode: policy.mode,
        policyAllowed: policy.allowed,
        policyReason: policy.reason,
        payload: {
          type: 'post',
          receiveIdType: 'user_id',
          content: {
            zh_cn: {
              title: '您被添加为合并请求评审人',
              content: [
                ...lines.map((line: string) => [{ tag: 'text', text: line }]),
                [
                  {
                    tag: 'a',
                    text: '在需求平台查看',
                    href: pullRequestPlatformUrl(assignment.pullNumber),
                  },
                ],
              ],
            },
          },
        },
      },
      true,
    );
    const claim = (
      await this.deliveries.claim('platform_pr', [deliveryId], 1)
    )[0];
    if (!claim) {
      const previous = await this.deliveries.status(deliveryId);
      if (previous.state === 'sent')
        await this.recordNotificationResult(
          assignment.id,
          assignment.notificationClaimToken,
          true,
          '',
        );
      return previous.state === 'sent';
    }
    let receipt;
    try {
      receipt = await this.feishu.sendMessageWithReceipt(
        claim.targetId,
        claim.payload.receiveIdType,
        claim.payload.type,
        claim.payload.content,
        claim.idempotencyKey,
      );
    } catch (error) {
      const failure: FeishuMessageDeliveryError =
        error instanceof FeishuMessageDeliveryError
          ? error
          : new FeishuMessageDeliveryError(
              'unknown',
              'message_transport_ambiguous',
            );
      await this.deliveries.result({
        id: claim.id,
        leaseToken: claim.leaseToken,
        outcome: failure.outcome,
        errorCode: failure.errorCode,
      });
      if (failure.outcome === 'rejected')
        await this.recordNotificationResult(
          assignment.id,
          assignment.notificationClaimToken,
          false,
          failure.errorCode,
        );
      this.logger.warn(`合并请求通知未确认：${failure.errorCode}`);
      return false;
    }
    try {
      const result = await this.deliveries.result({
        id: claim.id,
        leaseToken: claim.leaseToken,
        outcome: 'sent',
        ...receipt,
      });
      if (!result.accepted) return false;
      await this.recordNotificationResult(
        assignment.id,
        assignment.notificationClaimToken,
        true,
        '',
      );
      return true;
    } catch {
      // The upstream accepted the message. Never turn a local receipt-write failure into another send.
      this.logger.error('合并请求消息已返回回执，但本地确认尚未完成');
      return false;
    }
  }

  private async recordNotificationResult(
    assignmentId: string,
    claimToken: string,
    success: boolean,
    errorMessage: string,
  ): Promise<void> {
    const rows = await this.serviceRoleDatabase.run(
      (database: PostgresJsDatabase) =>
        database.execute<NotificationResultRow>(sql`
          SELECT pull_request_reviewer_notification_event_result(
            ${assignmentId}::uuid,
            ${claimToken}::uuid,
            ${success}::boolean,
            ${errorMessage}::text
          ) AS result
        `),
    );
    const rawResult = rows[0]?.result;
    const result =
      typeof rawResult === 'string'
        ? (JSON.parse(rawResult) as {
            affectedCount?: number;
            success?: boolean;
          })
        : rawResult;
    if (result?.affectedCount !== 1 || result.success !== true) {
      throw new Error('通知投递租约已失效，拒绝写回结果');
    }
  }

  private async notifyAssignments(rows: ReviewerRecord[]): Promise<number> {
    if (!rows.length) return 0;
    const pullNumbers: number[] = [
      ...new Set(rows.map((row: ReviewerRecord): number => row.pullNumber)),
    ];
    let snapshots: ReviewerNotificationSnapshot[] =
      await this.serviceRoleDatabase.run((database: PostgresJsDatabase) =>
        database.execute(
          database
            .select({
              title: pullRequestSnapshot.title,
              headRef: sql<string>`${pullRequestSnapshot.headRef}`.as(
                'headRef',
              ),
              baseRef: sql<string>`${pullRequestSnapshot.baseRef}`.as(
                'baseRef',
              ),
              pullNumber: sql<number>`${pullRequestSnapshot.pullNumber}`.as(
                'pullNumber',
              ),
            })
            .from(pullRequestSnapshot)
            .where(
              and(
                eq(pullRequestSnapshot.repository, this.github.repository()),
                inArray(pullRequestSnapshot.pullNumber, pullNumbers),
              ),
            ),
        ),
      );
    let snapshotMap: Map<number, ReviewerNotificationSnapshot> = new Map(
      snapshots.map(
        (
          snapshot: ReviewerNotificationSnapshot,
        ): [number, ReviewerNotificationSnapshot] => [
          snapshot.pullNumber,
          snapshot,
        ],
      ),
    );
    const missingSnapshot: boolean = pullNumbers.some(
      (pullNumber: number): boolean => !snapshotMap.has(pullNumber),
    );
    if (missingSnapshot) {
      for (const number of pullNumbers)
        if (!snapshotMap.has(number)) await this.refreshPullRequest(number);
      snapshots = await this.serviceRoleDatabase.run(
        (database: PostgresJsDatabase) =>
          database.execute(
            database
              .select({
                title: pullRequestSnapshot.title,
                headRef: sql<string>`${pullRequestSnapshot.headRef}`.as(
                  'headRef',
                ),
                baseRef: sql<string>`${pullRequestSnapshot.baseRef}`.as(
                  'baseRef',
                ),
                pullNumber: sql<number>`${pullRequestSnapshot.pullNumber}`.as(
                  'pullNumber',
                ),
              })
              .from(pullRequestSnapshot)
              .where(
                and(
                  eq(pullRequestSnapshot.repository, this.github.repository()),
                  inArray(pullRequestSnapshot.pullNumber, pullNumbers),
                ),
              ),
          ),
      );
      snapshotMap = new Map(
        snapshots.map(
          (
            snapshot: ReviewerNotificationSnapshot,
          ): [number, ReviewerNotificationSnapshot] => [
            snapshot.pullNumber,
            snapshot,
          ],
        ),
      );
    }
    const results: boolean[] = await Promise.all(
      rows.map(async (row: ReviewerRecord): Promise<boolean> => {
        const snapshot: ReviewerNotificationSnapshot | undefined =
          snapshotMap.get(row.pullNumber);
        if (!snapshot) {
          if (row.notificationClaimToken) {
            await this.recordNotificationResult(
              row.id,
              row.notificationClaimToken,
              false,
              '未找到对应的合并请求快照',
            );
          }
          return false;
        }
        return this.notifyReviewer(row, snapshot);
      }),
    );
    return results.filter(Boolean).length;
  }

  private async claimNotifications(
    assignmentIds: string[],
  ): Promise<ReviewerRecord[]> {
    const claimed = await this.serviceRoleDatabase.run(
      (database: PostgresJsDatabase) =>
        database.execute<ReviewerEventRow>(sql`
          SELECT *
          FROM pull_request_reviewer_notification_events_claim(
            ${this.github.repository()}::text,
            ${JSON.stringify(assignmentIds)}::jsonb,
            ${MAX_NOTIFICATION_ATTEMPTS}::integer,
            ${NOTIFICATION_BATCH_SIZE}::integer,
            ${NOTIFICATION_LEASE_SECONDS}::integer
          )
        `),
    );
    return this.reviewerEvents(claimed);
  }

  private dispatchPendingNotifications(): void {
    if (process.env.MAKIT_WORKERS_ENABLED === 'false') return;
    if (this.notificationDispatching) return;
    this.notificationDispatching = true;
    void this.reconcilePendingReviewerNotifications()
      .then(() => this.claimNotifications([]))
      .then(async (claimed: ReviewerRecord[]): Promise<void> => {
        await this.notifyAssignments(claimed);
      })
      .catch((error: unknown): void => {
        this.logger.error(
          `重试合并请求评审通知失败：${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally((): void => {
        this.notificationDispatching = false;
      });
  }
}
