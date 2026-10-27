import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import type {
  GitHubActorSummary,
  PullRequestCheckSummary,
  PullRequestReviewSummary,
  PullRequestReviewThreadSummary,
  RequirementPatch,
  RequirementReleaseReadiness,
  RequirementReleaseReadinessCheck,
  RequirementSummary,
} from '@shared/api.interface';
import { pullRequestSnapshot } from '../../database/schema';
import {
  parseJsonArray,
  requirementCodesFromPullRequest,
} from '../pull-requests/pull-requests.model';
import { DEFAULT_REPOSITORY } from '../pull-requests/github-pull-requests.service';
import { PullRequestRefreshCoordinatorService } from '../pull-requests/pull-request-refresh-coordinator.service';
import { FeishuService, type BaseRecord } from './feishu.service';
import { hasMeaningfulText } from './requirements.model';
import { RequirementsQueryService } from './requirements-query.service';

type PullRequestSnapshotRecord = typeof pullRequestSnapshot.$inferSelect;

interface ReleasePullRequestSnapshot {
  pullNumber: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  url: string;
  headRef: string;
  reviewDecision: string;
  checksStatus: string;
  requestedReviewers: GitHubActorSummary[];
  reviews: PullRequestReviewSummary[];
  reviewThreads: PullRequestReviewThreadSummary[];
  checks: PullRequestCheckSummary[];
  syncedAt: Date;
}

const RELEASE_STATUSES: ReadonlySet<string> = new Set(['待发布', '已发布']);
const SNAPSHOT_MAX_AGE_MS: number = 30 * 60 * 1000;

@Injectable()
export class RequirementReleaseReadinessService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly feishu: FeishuService,
    private readonly query: RequirementsQueryService,
    private readonly refreshCoordinator: PullRequestRefreshCoordinatorService,
  ) {}

  async evaluate(
    requirement: RequirementSummary,
    targetStatus: string,
    patch: RequirementPatch = {},
    refreshGitHub: boolean = false,
  ): Promise<RequirementReleaseReadiness> {
    this.assertReleaseStatus(targetStatus);
    const edge = requirement.workflow?.transitions.find(
      (item) => item.from === requirement.status && item.to === targetStatus,
    );
    if (requirement.workflow && !edge)
      throw new BadRequestException('当前迭代未允许此状态流转');
    const selected = edge ? new Set<string>(edge.releaseChecks) : null;
    const needsAcceptance =
      !selected ||
      selected.has('acceptance_items') ||
      selected.has('acceptance_complete');
    const needsGithub =
      !selected ||
      [...selected].some((key) =>
        [
          'pull_request',
          'pull_request_snapshot_fresh',
          'pull_request_not_draft',
          'github_checks',
          'github_review',
          'review_threads',
          'pull_request_state',
        ].includes(key),
      );
    const acceptanceRecords: BaseRecord[] = needsAcceptance
      ? await this.feishu.searchRecords(
          this.query.table('FEISHU_ACCEPTANCE_TABLE'),
          {
            conjunction: 'and',
            conditions: [
              {
                fieldName: '需求',
                operator: 'contains',
                value: [requirement.id],
              },
            ],
          },
        )
      : [];
    const gitBranchName: string = (
      patch.gitBranchName ?? requirement.gitBranchName
    ).trim();
    const githubPullRequestUrl: string = (
      patch.githubPullRequestUrl ?? requirement.githubPullRequestUrl
    ).trim();
    const pullRequest: ReleasePullRequestSnapshot | null = needsGithub
      ? await this.linkedPullRequest(
          requirement,
          gitBranchName,
          githubPullRequestUrl,
          refreshGitHub,
        )
      : null;
    const reviewThreads: PullRequestReviewThreadSummary[] =
      pullRequest?.reviewThreads || [];
    const githubChecks: PullRequestCheckSummary[] = pullRequest?.checks || [];
    const requestedReviewers: GitHubActorSummary[] =
      pullRequest?.requestedReviewers || [];
    const latestHumanReviews: Map<string, PullRequestReviewSummary> = new Map();
    if (pullRequest) {
      pullRequest.reviews
        .filter(
          (review: PullRequestReviewSummary): boolean =>
            !this.isAutomatedActor(review.author.login),
        )
        .sort(
          (left: PullRequestReviewSummary, right: PullRequestReviewSummary) =>
            this.reviewTimestamp(left) - this.reviewTimestamp(right),
        )
        .forEach((review: PullRequestReviewSummary): void => {
          latestHumanReviews.set(review.author.login.toLowerCase(), review);
        });
    }
    const unresolvedThreadCount: number = reviewThreads.filter(
      (thread: PullRequestReviewThreadSummary): boolean =>
        !thread.resolved && !thread.outdated,
    ).length;
    const snapshotAgeMs: number = pullRequest
      ? Date.now() - pullRequest.syncedAt.getTime()
      : Number.POSITIVE_INFINITY;
    const snapshotFresh: boolean =
      Boolean(pullRequest) &&
      Number.isFinite(snapshotAgeMs) &&
      snapshotAgeMs >= 0 &&
      snapshotAgeMs <= SNAPSHOT_MAX_AGE_MS;
    const acceptanceComplete: boolean =
      acceptanceRecords.length > 0 &&
      acceptanceRecords.every(
        (record: BaseRecord): boolean => record.fields['是否完成'] === true,
      );
    const testers: number = this.personnelCount(
      patch.testerUserIds,
      patch.testerLarkUserIds,
      requirement.testers.length,
    );
    const releaseOwners: number = this.personnelCount(
      patch.releaseOwnerUserIds,
      patch.releaseOwnerLarkUserIds,
      requirement.releaseOwners.length,
    );
    const selfTestReport: string =
      patch.selfTestReport ?? requirement.selfTestReport;
    const requireMerged: boolean = targetStatus === '已发布';
    const pullRequestMerged: boolean = pullRequest?.state === 'MERGED';
    const githubChecksPassed: boolean = Boolean(
      pullRequest &&
      (pullRequestMerged ||
        (pullRequest.checksStatus !== 'FAILURE' &&
          pullRequest.checksStatus !== 'ERROR' &&
          pullRequest.checksStatus !== 'PENDING' &&
          githubChecks.every(
            (check: PullRequestCheckSummary): boolean =>
              !['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(
                check.conclusion || check.status,
              ) &&
              !['QUEUED', 'IN_PROGRESS', 'PENDING', 'EXPECTED'].includes(
                check.status,
              ),
          ))),
    );
    const latestHumanChangeRequests: PullRequestReviewSummary[] = [
      ...latestHumanReviews.values(),
    ].filter(
      (review: PullRequestReviewSummary): boolean =>
        review.state === 'CHANGES_REQUESTED',
    );
    const githubReviewPassed: boolean = Boolean(
      pullRequest &&
      (pullRequestMerged ||
        (pullRequest.reviewDecision !== 'CHANGES_REQUESTED' &&
          pullRequest.reviewDecision !== 'REVIEW_REQUIRED' &&
          requestedReviewers.length === 0 &&
          latestHumanChangeRequests.length === 0)),
    );
    const checks: RequirementReleaseReadinessCheck[] = [
      this.check(
        'acceptance_items',
        '已建立验收项',
        acceptanceRecords.length > 0,
        acceptanceRecords.length
          ? `共 ${acceptanceRecords.length} 项`
          : '至少需要一项可追踪的验收项',
      ),
      this.check(
        'acceptance_complete',
        '验收项全部完成',
        acceptanceComplete,
        acceptanceComplete
          ? `${acceptanceRecords.length} 项均已完成`
          : `${acceptanceRecords.filter((record: BaseRecord): boolean => record.fields['是否完成'] !== true).length} 项尚未完成`,
      ),
      this.check(
        'self_test_report',
        '自测报告已填写',
        hasMeaningfulText(selfTestReport),
        hasMeaningfulText(selfTestReport) ? '已填写' : '缺少有效自测报告',
      ),
      this.check(
        'testers',
        '测试人员已设置',
        testers > 0,
        testers > 0 ? `已设置 ${testers} 人` : '缺少测试人员',
      ),
      this.check(
        'release_owners',
        '发布负责人已设置',
        releaseOwners > 0,
        releaseOwners > 0 ? `已设置 ${releaseOwners} 人` : '缺少发布负责人',
      ),
      this.check(
        'git_branch',
        'GitHub 开发关联已设置',
        Boolean(gitBranchName || githubPullRequestUrl),
        gitBranchName || githubPullRequestUrl || '缺少 Git 分支或合并请求链接',
      ),
      this.check(
        'pull_request',
        '已关联合并请求',
        Boolean(pullRequest),
        pullRequest
          ? `#${pullRequest.pullNumber} ${pullRequest.title}`
          : '未找到链接、分支或需求编号对应的合并请求',
        pullRequest?.url,
      ),
      this.check(
        'pull_request_snapshot_fresh',
        '合并请求数据为最新',
        snapshotFresh,
        !pullRequest
          ? '尚未关联合并请求'
          : snapshotFresh
            ? '快照在 30 分钟内同步'
            : '合并请求数据已过期，请先刷新',
        pullRequest?.url,
      ),
      this.check(
        'pull_request_not_draft',
        '合并请求已就绪',
        Boolean(pullRequest && !pullRequest.draft),
        !pullRequest
          ? '尚未关联合并请求'
          : pullRequest.draft
            ? '合并请求仍为草稿'
            : '非草稿',
        pullRequest?.url,
      ),
      this.check(
        'github_checks',
        'GitHub 检查无阻塞',
        githubChecksPassed,
        pullRequest
          ? pullRequestMerged
            ? '合并请求已合并，GitHub 已完成合并门禁'
            : githubChecks.length
              ? `共 ${githubChecks.length} 项，状态：${pullRequest.checksStatus || 'UNKNOWN'}`
              : pullRequest.checksStatus === 'SUCCESS'
                ? '检查已通过'
                : '仓库未返回检查项，按无阻塞处理'
          : '尚未关联合并请求',
        pullRequest?.url,
      ),
      this.check(
        'github_review',
        '代码评审无阻塞',
        githubReviewPassed,
        pullRequest
          ? pullRequestMerged
            ? '合并请求已合并，GitHub 已完成评审门禁'
            : requestedReviewers.length
              ? `${requestedReviewers.length} 位评审人尚未完成评审`
              : latestHumanChangeRequests.length
                ? `${latestHumanChangeRequests.length} 位评审人要求修改`
                : pullRequest.reviewDecision === 'APPROVED'
                  ? '已批准'
                  : '仓库未要求强制审批，且没有待处理评审或修改意见'
          : '尚未关联合并请求',
        pullRequest?.url,
      ),
      this.check(
        'review_threads',
        '评审讨论已闭环',
        Boolean(pullRequest) &&
          (pullRequestMerged || unresolvedThreadCount === 0),
        pullRequest
          ? pullRequestMerged
            ? '合并请求已合并'
            : unresolvedThreadCount
              ? `${unresolvedThreadCount} 个有效讨论仍未解决`
              : '没有未解决的有效讨论'
          : '尚未关联合并请求',
        pullRequest?.url,
      ),
      this.check(
        'pull_request_state',
        requireMerged ? '合并请求已合并' : '合并请求处于有效状态',
        Boolean(
          pullRequest &&
          (requireMerged
            ? pullRequest.state === 'MERGED'
            : ['OPEN', 'MERGED'].includes(pullRequest.state)),
        ),
        pullRequest ? `当前状态：${pullRequest.state}` : '尚未关联合并请求',
        pullRequest?.url,
      ),
    ];
    const effectiveChecks = selected
      ? checks.filter((check) => selected.has(check.key))
      : checks;
    const blockingReasons: string[] = effectiveChecks
      .filter(
        (check: RequirementReleaseReadinessCheck): boolean =>
          check.blocking && !check.passed,
      )
      .map(
        (check: RequirementReleaseReadinessCheck): string =>
          `${check.label}：${check.detail}`,
      );
    return {
      requirementId: requirement.id,
      targetStatus,
      ready: blockingReasons.length === 0,
      checks: effectiveChecks,
      blockingReasons,
    };
  }

  async assertReady(
    requirement: RequirementSummary,
    targetStatus: string,
    patch: RequirementPatch = {},
  ): Promise<RequirementReleaseReadiness> {
    const readiness: RequirementReleaseReadiness = await this.evaluate(
      requirement,
      targetStatus,
      patch,
      true,
    );
    if (!readiness.ready) {
      const labels: string[] = readiness.checks
        .filter(
          (check: RequirementReleaseReadinessCheck): boolean =>
            check.blocking && !check.passed,
        )
        .map((check: RequirementReleaseReadinessCheck): string => check.label);
      const visible: string = labels.slice(0, 4).join('、');
      const suffix: string = labels.length > 4 ? '等' : '';
      throw new BadRequestException(`发布就绪检查未通过：${visible}${suffix}`);
    }
    return readiness;
  }

  private assertReleaseStatus(targetStatus: string): void {
    if (!RELEASE_STATUSES.has(targetStatus)) {
      throw new BadRequestException('发布就绪检查仅支持发布阶段状态');
    }
  }

  private personnelCount(
    miaodaIds: string[] | undefined,
    larkIds: string[] | undefined,
    currentCount: number,
  ): number {
    if (larkIds !== undefined) return new Set(larkIds.filter(Boolean)).size;
    if (miaodaIds !== undefined) {
      return new Set(miaodaIds.filter(Boolean)).size;
    }
    return currentCount;
  }

  private check(
    key: string,
    label: string,
    passed: boolean,
    detail: string,
    url?: string,
  ): RequirementReleaseReadinessCheck {
    return {
      key,
      label,
      passed,
      blocking: true,
      detail,
      ...(url ? { url } : {}),
    };
  }

  private isAutomatedActor(login: string): boolean {
    return /\[bot\]$|codex|copilot|github-actions/iu.test(login);
  }

  private reviewTimestamp(review: PullRequestReviewSummary): number {
    const timestamp: number = review.submittedAt
      ? new Date(review.submittedAt).getTime()
      : 0;
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private async linkedPullRequest(
    requirement: RequirementSummary,
    gitBranchName: string,
    githubPullRequestUrl: string,
    refreshGitHub: boolean,
  ): Promise<ReleasePullRequestSnapshot | null> {
    const repository: string =
      process.env.GITHUB_REPOSITORY?.trim() || DEFAULT_REPOSITORY;
    const snapshots: PullRequestSnapshotRecord[] = await this.db
      .select()
      .from(pullRequestSnapshot)
      .where(eq(pullRequestSnapshot.repository, repository))
      .orderBy(desc(pullRequestSnapshot.githubUpdatedAt));
    const repositorySnapshots: PullRequestSnapshotRecord[] = snapshots.filter(
      (snapshot: PullRequestSnapshotRecord): boolean =>
        snapshot.repository === repository,
    );
    let match: PullRequestSnapshotRecord | undefined =
      this.findLinkedPullRequest(
        repositorySnapshots,
        requirement,
        gitBranchName,
        githubPullRequestUrl,
      );
    let number: number | undefined = match?.pullNumber;
    if (githubPullRequestUrl) {
      try {
        const url: URL = new URL(githubPullRequestUrl);
        const expected: string = `/${repository}/pull/`;
        const suffix: string = url.pathname.startsWith(expected) ? url.pathname.slice(expected.length) : '';
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !/^[1-9]\d*\/?$/u.test(suffix)) return null;
        number = Number(suffix.replace(/\/$/u, ''));
      } catch { return null; }
    }
    if (refreshGitHub && number) {
      await this.refreshCoordinator.refresh({ pullNumber: number, waitForConcurrent: true, cooldownSeconds: 0, authoritative: true });
      [match] = await this.db.select().from(pullRequestSnapshot).where(and(eq(pullRequestSnapshot.repository, repository), eq(pullRequestSnapshot.pullNumber, number))).limit(1);
    }
    return match ? this.databaseSnapshot(match) : null;
  }

  private findLinkedPullRequest<
    T extends { title: string; body: string; headRef: string; url: string },
  >(
    snapshots: T[],
    requirement: RequirementSummary,
    gitBranchName: string,
    githubPullRequestUrl: string,
  ): T | undefined {
    if (githubPullRequestUrl) return snapshots.find(
        (snapshot: T): boolean =>
          snapshot.url.trim() === githubPullRequestUrl,
      );
    return (
      snapshots.find((snapshot: T): boolean => Boolean(gitBranchName) && snapshot.headRef.trim() === gitBranchName) ||
      snapshots.find((snapshot: T): boolean =>
        requirementCodesFromPullRequest(snapshot).has(
          requirement.code.toUpperCase(),
        ),
      )
    );
  }

  private databaseSnapshot(
    snapshot: PullRequestSnapshotRecord,
  ): ReleasePullRequestSnapshot {
    return {
      pullNumber: snapshot.pullNumber,
      title: snapshot.title,
      body: snapshot.body,
      state: snapshot.state,
      draft: snapshot.draft,
      url: snapshot.url,
      headRef: snapshot.headRef,
      reviewDecision: snapshot.reviewDecision,
      checksStatus: snapshot.checksStatus,
      requestedReviewers: parseJsonArray<GitHubActorSummary>(
        snapshot.requestedReviewersJson,
      ),
      reviews: parseJsonArray<PullRequestReviewSummary>(snapshot.reviewsJson),
      reviewThreads: parseJsonArray<PullRequestReviewThreadSummary>(
        snapshot.reviewThreadsJson,
      ),
      checks: parseJsonArray<PullRequestCheckSummary>(snapshot.checksJson),
      syncedAt: snapshot.syncedAt,
    };
  }
}
