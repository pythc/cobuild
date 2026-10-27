import { createSign } from 'node:crypto';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios, { type AxiosInstance, isAxiosError } from 'axios';
import { GitHubResourceCacheService } from './github-resource-cache.service';
import { OperationsTelemetryService } from '../operations/operations-telemetry.service';
import type {
  GitHubActorSummary,
  PullRequestCheckSummary,
  PullRequestCommentSummary,
  PullRequestReviewSummary,
  PullRequestReviewThreadSummary,
} from '@shared/api.interface';

interface GitHubActorNode {
  login?: string;
  avatarUrl?: string;
}

interface GitHubCommentNode {
  id?: string;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  path?: string;
  line?: number | null;
  author?: GitHubActorNode | null;
}

interface GitHubReviewNode {
  id?: string;
  state?: string;
  body?: string;
  submittedAt?: string;
  url?: string;
  author?: GitHubActorNode | null;
}

interface GitHubReviewRequestNode {
  requestedReviewer?: GitHubActorNode | null;
}

interface GitHubReviewThreadNode {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: { nodes?: GitHubCommentNode[] };
}

interface GitHubCheckNode {
  __typename?: 'CheckRun' | 'StatusContext';
  name?: string;
  status?: string;
  conclusion?: string;
  detailsUrl?: string;
  completedAt?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
}

interface GitHubPullRequestNode {
  number: number;
  title?: string;
  body?: string;
  state?: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft?: boolean;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
  mergedAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergeable?: string;
  reviewDecision?: string;
  headRefName?: string;
  baseRefName?: string;
  author?: GitHubActorNode | null;
  comments?: { totalCount?: number; nodes?: GitHubCommentNode[] };
  reviews?: { totalCount?: number; nodes?: GitHubReviewNode[] };
  reviewRequests?: {
    totalCount?: number;
    nodes?: GitHubReviewRequestNode[];
  };
  reviewThreads?: {
    totalCount?: number;
    nodes?: GitHubReviewThreadNode[];
  };
  commits?: {
    totalCount?: number;
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          state?: string;
          contexts?: { totalCount?: number; nodes?: GitHubCheckNode[] };
        } | null;
      };
    }>;
  };
}

interface GitHubGraphQlResponse {
  data?: {
    repository?: {
      pullRequest?: GitHubPullRequestNode | null;
      pullRequests?: {
        nodes?: GitHubPullRequestNode[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

interface GitHubCollaboratorResponse {
  login?: string;
  avatar_url?: string;
  permissions?: { push?: boolean };
}

interface GitHubRequestedReviewersResponse {
  users?: Array<{ login?: string; avatar_url?: string }>;
}

export interface GitHubPullRequestSnapshot {
  repository: string;
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  draft: boolean;
  url: string;
  author: GitHubActorSummary;
  headRef: string;
  baseRef: string;
  mergeable: string;
  reviewDecision: string;
  checksStatus: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  commentCount: number;
  reviewCount: number;
  reviewThreadCount: number;
  comments: PullRequestCommentSummary[];
  reviews: PullRequestReviewSummary[];
  requestedReviewers: GitHubActorSummary[];
  reviewThreads: PullRequestReviewThreadSummary[];
  checks: PullRequestCheckSummary[];
  createdAt: string | null;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface GitHubReviewerMutation {
  requestedReviewers: GitHubActorSummary[];
  addedLogins: string[];
  removedLogins: string[];
  fullyApplied: boolean;
  warning: string;
}

const DEFAULT_REPOSITORY: string = 'pythc/ai-homework-system';

const PULL_REQUEST_FIELDS: string = `
          number title body state isDraft url createdAt updatedAt closedAt mergedAt
          additions deletions changedFiles mergeable reviewDecision headRefName baseRefName
          author { login avatarUrl }
          comments(first: 50) {
            totalCount
            nodes { id body createdAt updatedAt url author { login avatarUrl } }
          }
          reviews(first: 50) {
            totalCount
            nodes { id state body submittedAt url author { login avatarUrl } }
          }
          reviewRequests(first: 50) {
            totalCount
            nodes {
              requestedReviewer {
                ... on User { login avatarUrl }
              }
            }
          }
          reviewThreads(first: 50) {
            totalCount
            nodes {
              id isResolved isOutdated
              comments(first: 50) {
                nodes { id body createdAt updatedAt url path line author { login avatarUrl } }
              }
            }
          }
          commits(last: 1) {
            totalCount
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts(first: 50) {
                    totalCount
                    nodes {
                      __typename
                      ... on CheckRun { name status conclusion detailsUrl completedAt }
                      ... on StatusContext { context state targetUrl }
                    }
                  }
                }
              }
            }
          }
`;

const PULL_REQUEST_QUERY: string = `query PullRequests($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PULL_REQUEST_FIELDS} }
    }
  }
}`;

const SINGLE_PULL_REQUEST_QUERY: string = `query PullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PULL_REQUEST_FIELDS} } }
}`;

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/gu, '')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_');
}

function actor(node?: GitHubActorNode | null): GitHubActorSummary {
  return {
    login: node?.login || 'ghost',
    avatarUrl: node?.avatarUrl || '',
  };
}

function comment(node: GitHubCommentNode): PullRequestCommentSummary {
  return {
    id: node.id || '',
    body: node.body || '',
    createdAt: node.createdAt || null,
    updatedAt: node.updatedAt || null,
    url: node.url || '',
    author: actor(node.author),
    path: node.path,
    line: node.line ?? null,
  };
}

function review(node: GitHubReviewNode): PullRequestReviewSummary {
  return {
    id: node.id || '',
    state: node.state || 'PENDING',
    body: node.body || '',
    submittedAt: node.submittedAt || null,
    url: node.url || '',
    author: actor(node.author),
  };
}

function check(node: GitHubCheckNode): PullRequestCheckSummary {
  if (node.__typename === 'StatusContext') {
    return {
      kind: 'status-context',
      name: node.context || 'Status',
      status: node.state || 'UNKNOWN',
      conclusion: node.state || 'UNKNOWN',
      url: node.targetUrl || '',
      completedAt: null,
    };
  }
  return {
    kind: 'check-run',
    name: node.name || 'Check',
    status: node.status || 'UNKNOWN',
    conclusion: node.conclusion || '',
    url: node.detailsUrl || '',
    completedAt: node.completedAt || null,
  };
}

function normalize(
  repository: string,
  node: GitHubPullRequestNode,
): GitHubPullRequestSnapshot {
  const statusRollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const reviewNodes: GitHubReviewNode[] = node.reviews?.nodes || [];
  const reviewRequestNodes: GitHubReviewRequestNode[] =
    node.reviewRequests?.nodes || [];
  const reviewThreadNodes: GitHubReviewThreadNode[] =
    node.reviewThreads?.nodes || [];
  const checkNodes: GitHubCheckNode[] = statusRollup?.contexts?.nodes || [];
  const releaseDataComplete: boolean = [
    [node.comments?.totalCount, node.comments?.nodes?.length || 0],
    [node.reviews?.totalCount, reviewNodes.length],
    [node.reviewRequests?.totalCount, reviewRequestNodes.length],
    [node.reviewThreads?.totalCount, reviewThreadNodes.length],
    [statusRollup?.contexts?.totalCount, checkNodes.length],
  ].every(([total, loaded]): boolean => Number(total || 0) <= Number(loaded));
  const checks: PullRequestCheckSummary[] = checkNodes.map(check);
  if (!releaseDataComplete) {
    checks.push({
      kind: 'check-run',
      name: 'GitHub 评审数据完整性',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      url: node.url || '',
      completedAt: null,
    });
  }
  return {
    repository,
    number: node.number,
    title: node.title || `Pull Request #${node.number}`,
    body: node.body || '',
    state: node.state || 'CLOSED',
    draft: Boolean(node.isDraft),
    url: node.url || '',
    author: actor(node.author),
    headRef: node.headRefName || '',
    baseRef: node.baseRefName || '',
    mergeable: node.mergeable || 'UNKNOWN',
    reviewDecision: node.reviewDecision || '',
    checksStatus: releaseDataComplete
      ? statusRollup?.state || 'UNKNOWN'
      : 'ERROR',
    additions: Number(node.additions || 0),
    deletions: Number(node.deletions || 0),
    changedFiles: Number(node.changedFiles || 0),
    commitCount: Number(node.commits?.totalCount || 0),
    commentCount: Number(node.comments?.totalCount || 0),
    reviewCount: Number(node.reviews?.totalCount || 0),
    reviewThreadCount: Number(node.reviewThreads?.totalCount || 0),
    comments: (node.comments?.nodes || []).map(comment),
    reviews: reviewNodes.map(review),
    requestedReviewers: reviewRequestNodes
      .map(
        (request: GitHubReviewRequestNode): GitHubActorSummary =>
          actor(request.requestedReviewer),
      )
      .filter(
        (reviewer: GitHubActorSummary): boolean => reviewer.login !== 'ghost',
      ),
    reviewThreads: reviewThreadNodes.map(
      (thread: GitHubReviewThreadNode): PullRequestReviewThreadSummary => ({
        id: thread.id || '',
        resolved: Boolean(thread.isResolved),
        outdated: Boolean(thread.isOutdated),
        comments: (thread.comments?.nodes || []).map(comment),
      }),
    ),
    checks,
    createdAt: node.createdAt || null,
    updatedAt: node.updatedAt || new Date(0).toISOString(),
    closedAt: node.closedAt || null,
    mergedAt: node.mergedAt || null,
  };
}

@Injectable()
export class GitHubPullRequestsService {
  constructor(private readonly resourceCache?: GitHubResourceCacheService, private readonly telemetry?: OperationsTelemetryService) {}

  private measure<T>(operation: string, work: () => Promise<T>): Promise<T> {
    return this.telemetry ? this.telemetry.measure('github', operation, work) : work();
  }
  private readonly logger: Logger = new Logger(GitHubPullRequestsService.name);
  private readonly client: AxiosInstance = axios.create({
    baseURL: 'https://api.github.com',
    timeout: 30_000,
    maxRedirects: 3,
  });
  private installationToken: { value: string; expiresAt: number } | null = null;
  private reviewerCandidateCache: {
    value: GitHubActorSummary[];
    expiresAt: number;
  } | null = null;

  repository(): string {
    const value: string =
      process.env.GITHUB_REPOSITORY?.trim() || DEFAULT_REPOSITORY;
    if (!/^[^/\s]+\/[^/\s]+$/u.test(value)) {
      throw new ServiceUnavailableException('GITHUB_REPOSITORY 配置不正确');
    }
    return value;
  }

  private appJwt(appId: string, privateKey: string): string {
    const now: number = Math.floor(Date.now() / 1000);
    const header: string = base64Url(
      JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
    );
    const payload: string = base64Url(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
    );
    const unsigned: string = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature: string = base64Url(
      signer.sign(privateKey.replace(/\\n/gu, '\n')),
    );
    return `${unsigned}.${signature}`;
  }

  private async appInstallationToken(): Promise<string> {
    if (
      this.installationToken &&
      this.installationToken.expiresAt > Date.now() + 300_000
    ) {
      return this.installationToken.value;
    }
    const appId: string = process.env.GITHUB_APP_ID?.trim() || '';
    const installationId: string =
      process.env.GITHUB_APP_INSTALLATION_ID?.trim() || '';
    const privateKey: string = process.env.GITHUB_APP_PRIVATE_KEY?.trim() || '';
    if (!appId || !installationId || !privateKey) return '';
    const response = await this.client.post<{
      token?: string;
      expires_at?: string;
    }>(
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      null,
      {
        headers: {
          Authorization: `Bearer ${this.appJwt(appId, privateKey)}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    const value: string = response.data.token || '';
    if (!value) {
      throw new ServiceUnavailableException('GitHub App 未返回安装令牌');
    }
    this.installationToken = {
      value,
      expiresAt: Date.parse(response.data.expires_at || '') || Date.now(),
    };
    return value;
  }

  private async token(): Promise<string> {
    const appToken: string = await this.appInstallationToken();
    if (appToken) return appToken;
    const token: string = process.env.GITHUB_TOKEN?.trim() || '';
    if (!token) {
      throw new ServiceUnavailableException(
        '未配置 GitHub App 或 GITHUB_TOKEN，无法读取私有仓库',
      );
    }
    return token;
  }

  private repositoryPath(): string {
    const [owner, name]: string[] = this.repository().split('/');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private githubError(
    action: string,
    error: unknown,
  ): ServiceUnavailableException {
    const detail: string = isAxiosError(error)
      ? String(
          (error.response?.data as { message?: string } | undefined)?.message ||
            error.message,
        )
      : error instanceof Error
        ? error.message
        : String(error);
    this.logger.error(`${action}失败：${detail}`);
    return new ServiceUnavailableException(`${action}失败：${detail}`);
  }

  async reviewerCandidates(): Promise<GitHubActorSummary[]> {
    if (
      this.reviewerCandidateCache &&
      this.reviewerCandidateCache.expiresAt > Date.now()
    ) {
      return this.reviewerCandidateCache.value;
    }
    const token: string = await this.token();
    const candidates: GitHubActorSummary[] = [];
    let page: number = 1;
    try {
      while (true) {
        const response = await this.client.get<GitHubCollaboratorResponse[]>(
          `${this.repositoryPath()}/collaborators`,
          {
            headers: this.headers(token),
            params: {
              affiliation: 'all',
              permission: 'push',
              per_page: 100,
              page,
            },
          },
        );
        const rows: GitHubCollaboratorResponse[] = response.data || [];
        candidates.push(
          ...rows
            .filter((row: GitHubCollaboratorResponse): boolean =>
              Boolean(row.login && row.permissions?.push),
            )
            .map(
              (row: GitHubCollaboratorResponse): GitHubActorSummary => ({
                login: row.login || '',
                avatarUrl: row.avatar_url || '',
              }),
            ),
        );
        if (rows.length < 100) break;
        page += 1;
      }
      const sorted: GitHubActorSummary[] = candidates.sort(
        (left: GitHubActorSummary, right: GitHubActorSummary): number =>
          left.login.localeCompare(right.login),
      );
      this.reviewerCandidateCache = {
        value: sorted,
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
      return sorted;
    } catch (error) {
      throw this.githubError('读取 GitHub 评审人候选', error);
    }
  }

  private async requestedReviewers(
    pullNumber: number,
    token: string,
  ): Promise<GitHubActorSummary[]> {
    const path: string = `${this.repositoryPath()}/pulls/${pullNumber}/requested_reviewers`;
    const read = (etag: string | null) => this.measure('requested_reviewers', async () => {
      const response = await this.client.get<GitHubRequestedReviewersResponse>(path,
        { headers: { ...this.headers(token), ...(etag ? { 'If-None-Match': etag } : {}) }, validateStatus: (status: number): boolean => status === 200 || status === 304 });
      return { status: response.status, data: response.data, etag: String(response.headers?.etag || '') || null };
    });
    const data: GitHubRequestedReviewersResponse = this.resourceCache
      ? await this.resourceCache.conditional(this.repository(), path, read) : (await read(null)).data;
    return (data.users || [])
      .filter((user: { login?: string; avatar_url?: string }): boolean =>
        Boolean(user.login),
      )
      .map(
        (user: {
          login?: string;
          avatar_url?: string;
        }): GitHubActorSummary => ({
          login: user.login || '',
          avatarUrl: user.avatar_url || '',
        }),
      );
  }

  async currentRequestedReviewers(
    pullNumber: number,
  ): Promise<GitHubActorSummary[]> {
    const token: string = await this.token();
    try {
      return await this.requestedReviewers(pullNumber, token);
    } catch (error) {
      throw this.githubError('读取 GitHub 当前评审人', error);
    }
  }

  async replaceRequestedReviewers(
    pullNumber: number,
    reviewerLogins: string[],
    currentReviewers?: GitHubActorSummary[],
  ): Promise<GitHubReviewerMutation> {
    const token: string = await this.token();
    const path: string = `${this.repositoryPath()}/pulls/${pullNumber}/requested_reviewers`;
    try {
      const current: GitHubActorSummary[] =
        currentReviewers || (await this.requestedReviewers(pullNumber, token));
      const desired: Set<string> = new Set(
        reviewerLogins.map((login: string): string => login.toLowerCase()),
      );
      const existing: Set<string> = new Set(
        current.map((reviewer: GitHubActorSummary): string =>
          reviewer.login.toLowerCase(),
        ),
      );
      const additions: string[] = reviewerLogins.filter(
        (login: string): boolean => !existing.has(login.toLowerCase()),
      );
      const removals: string[] = current
        .filter(
          (reviewer: GitHubActorSummary): boolean =>
            !desired.has(reviewer.login.toLowerCase()),
        )
        .map((reviewer: GitHubActorSummary): string => reviewer.login);

      if (!additions.length && !removals.length) {
        return {
          requestedReviewers: current,
          addedLogins: [],
          removedLogins: [],
          fullyApplied: true,
          warning: '',
        };
      }
      let mutationError: unknown = null;
      try {
        if (additions.length) {
          await this.client.post(
            path,
            { reviewers: additions },
            { headers: this.headers(token) },
          );
        }
        if (removals.length) {
          await this.client.delete(path, {
            headers: this.headers(token),
            data: { reviewers: removals },
          });
        }
      } catch (error) {
        mutationError = error;
      }
      // GitHub may have accepted only part of a multi-step replacement. Read
      // back the authoritative state so callers can persist and notify the
      // actual additions before surfacing a recoverable conflict.
      const requestedReviewers: GitHubActorSummary[] =
        await this.requestedReviewers(pullNumber, token);
      const actual: Set<string> = new Set(
        requestedReviewers.map((reviewer: GitHubActorSummary): string =>
          reviewer.login.toLowerCase(),
        ),
      );
      const actualAdded: string[] = requestedReviewers
        .filter(
          (reviewer: GitHubActorSummary): boolean =>
            !existing.has(reviewer.login.toLowerCase()),
        )
        .map((reviewer: GitHubActorSummary): string => reviewer.login);
      const actualRemoved: string[] = current
        .filter(
          (reviewer: GitHubActorSummary): boolean =>
            !actual.has(reviewer.login.toLowerCase()),
        )
        .map((reviewer: GitHubActorSummary): string => reviewer.login);
      const fullyApplied: boolean =
        actual.size === desired.size &&
        [...desired].every((login: string): boolean => actual.has(login));
      return {
        requestedReviewers,
        addedLogins: actualAdded,
        removedLogins: actualRemoved,
        fullyApplied,
        warning: mutationError
          ? this.githubError('设置 GitHub 评审人', mutationError).message
          : fullyApplied
            ? ''
            : 'GitHub 返回的评审人状态与目标不一致',
      };
    } catch (error) {
      throw this.githubError('设置 GitHub 评审人', error);
    }
  }

  async fetchPullRequest(pullNumber: number): Promise<GitHubPullRequestSnapshot> {
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new ServiceUnavailableException('合并请求编号无效');
    const repository: string = this.repository();
    const [owner, name] = repository.split('/');
    const token: string = await this.token();
    return this.measure('get_pull', async (): Promise<GitHubPullRequestSnapshot> => {
      try {
        const response = await this.client.post<GitHubGraphQlResponse>('/graphql', {
          query: SINGLE_PULL_REQUEST_QUERY, variables: { owner, name, number: pullNumber },
        }, { headers: this.headers(token) });
        const node: GitHubPullRequestNode | null | undefined = response.data.data?.repository?.pullRequest;
        if (response.data.errors?.length || !node || node.number !== pullNumber) throw new ServiceUnavailableException('GitHub 未返回完整合并请求');
        return normalize(repository, node);
      } catch (error) { throw this.githubError('读取 GitHub 合并请求', error); }
    });
  }

  async fetchPullRequests(): Promise<GitHubPullRequestSnapshot[]> {
    const repository: string = this.repository();
    const [owner, name]: string[] = repository.split('/');
    const token: string = await this.token();
    const results: GitHubPullRequestSnapshot[] = [];
    let cursor: string | null = null;
    try {
      do {
        const response = await this.client.post<GitHubGraphQlResponse>(
          '/graphql',
          {
            query: PULL_REQUEST_QUERY,
            variables: { owner, name, cursor },
          },
          {
            headers: {
              ...this.headers(token),
            },
          },
        );
        if (response.data.errors?.length) {
          throw new Error(
            response.data.errors
              .map((item: { message?: string }): string => item.message || '')
              .filter(Boolean)
              .join('；') || 'GitHub GraphQL 返回错误',
          );
        }
        const connection = response.data.data?.repository?.pullRequests;
        if (!connection) {
          throw new Error(`未找到 GitHub 仓库 ${repository}`);
        }
        results.push(
          ...(connection.nodes || []).map(
            (node: GitHubPullRequestNode): GitHubPullRequestSnapshot =>
              normalize(repository, node),
          ),
        );
        cursor = connection.pageInfo?.hasNextPage
          ? connection.pageInfo.endCursor || null
          : null;
      } while (cursor);
      return results;
    } catch (error) {
      const detail: string = isAxiosError(error)
        ? String(
            (error.response?.data as { message?: string } | undefined)
              ?.message || error.message,
          )
        : error instanceof Error
          ? error.message
          : String(error);
      this.logger.error(`同步 GitHub 合并请求失败：${detail}`);
      throw new ServiceUnavailableException(`同步 GitHub 失败：${detail}`);
    }
  }
}

export { DEFAULT_REPOSITORY };
