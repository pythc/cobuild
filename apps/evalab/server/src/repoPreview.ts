import { HttpError } from './errors.js';
import { assertNoSecretMarker, firstLine, publicAuthor } from './security.js';
import type { RepoCommitMeta, RepoFetcher, RepoLookup } from './context.js';

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^(?!@)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/;

export type ParsedRepo = {
  provider: 'github' | 'gitee';
  owner: string;
  repo: string;
  branch?: string;
  canonicalUrl: string;
};

export function parseRepositoryUrl(raw: string, branch?: string): ParsedRepo {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, '仓库地址无法识别', 'REPO_REJECTED');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new HttpError(400, '仅允许不含凭据的 HTTPS GitHub 或 Gitee 地址', 'REPO_REJECTED');
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'gitee.com') {
    throw new HttpError(400, '仅允许 github.com 或 gitee.com', 'REPO_REJECTED');
  }
  if (url.search || url.hash || raw.includes('\\') || raw.includes('@')) {
    throw new HttpError(400, '仓库地址不能包含查询、凭据或跳转', 'REPO_REJECTED');
  }
  const parts = url.pathname.split('/').filter(Boolean).map(decodePiece);
  if (parts.length < 2 || parts.length > 4) {
    throw new HttpError(400, '仓库地址格式不正确', 'REPO_REJECTED');
  }
  const owner = parts[0] ?? '';
  let repo = parts[1] ?? '';
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || owner.includes('..') || repo.includes('..')) {
    throw new HttpError(400, '仓库路径不安全', 'REPO_REJECTED');
  }
  let pathBranch: string | undefined;
  if (parts.length > 2) {
    if (parts.length !== 4 || parts[2] !== 'tree' || !parts[3]) {
      throw new HttpError(400, '仓库地址只允许 /owner/repo 或 /owner/repo/tree/branch', 'REPO_REJECTED');
    }
    pathBranch = parts[3];
  }
  const chosen = branch?.trim() || pathBranch;
  if (chosen && !BRANCH_RE.test(chosen)) {
    throw new HttpError(400, '分支名称不安全', 'REPO_REJECTED');
  }
  return {
    provider: host === 'github.com' ? 'github' : 'gitee',
    owner,
    repo,
    ...(chosen ? { branch: chosen } : {}),
    canonicalUrl: `https://${host}/${owner}/${repo}`,
  };
}

function decodePiece(value: string): string {
  try {
    if (value.includes('%')) throw new Error('encoded');
    return value;
  } catch {
    throw new HttpError(400, '仓库路径不能包含编码字符', 'REPO_REJECTED');
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchRepoMetadata(input: RepoLookup, fetchImpl: FetchLike = fetch, githubToken?: string): Promise<RepoCommitMeta> {
  const parsed = parseRepositoryUrl(input.url, input.branch);
  const branch = parsed.branch ?? (await defaultBranch(parsed, fetchImpl, githubToken));
  if (!BRANCH_RE.test(branch)) throw new HttpError(400, '分支名称不安全', 'REPO_REJECTED');
  const commit = parsed.provider === 'github'
    ? await githubCommit(parsed, branch, fetchImpl, githubToken)
    : await giteeCommit(parsed, branch, fetchImpl);
  assertNoSecretMarker(commit.message);
  return {
    url: parsed.canonicalUrl,
    branch,
    sha: commit.sha.toLowerCase(),
    message: firstLine(commit.message) || 'empty',
    author: publicAuthor(commit.author),
    committedAt: commit.committedAt,
  };
}

export function selectRepoFetcher(ctx: { config: { nodeEnv: string; githubToken?: string }; repoFetcher?: RepoFetcher }): RepoFetcher {
  if (ctx.config.nodeEnv === 'production' || !ctx.repoFetcher) {
    const githubToken = ctx.config.githubToken;
    return (lookup) => fetchRepoMetadata(lookup, fetch, githubToken);
  }
  return ctx.repoFetcher;
}

async function defaultBranch(parsed: ParsedRepo, fetchImpl: FetchLike, githubToken?: string): Promise<string> {
  const url = parsed.provider === 'github'
    ? `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
    : `https://gitee.com/api/v5/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const body = await providerGet(parsed.provider, url, fetchImpl, githubToken);
  const branch = typeof body.default_branch === 'string' ? body.default_branch : '';
  if (!branch) throw new HttpError(502, '代码托管平台没有返回默认分支', 'REPO_PROVIDER');
  return branch;
}

async function githubCommit(parsed: ParsedRepo, branch: string, fetchImpl: FetchLike, githubToken?: string): Promise<{ sha: string; message: string; author: string; committedAt: string }> {
  const url = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(branch)}`;
  const body = await providerGet('github', url, fetchImpl, githubToken);
  return readCommit(body);
}

async function giteeCommit(parsed: ParsedRepo, branch: string, fetchImpl: FetchLike): Promise<{ sha: string; message: string; author: string; committedAt: string }> {
  const url = `https://gitee.com/api/v5/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(branch)}`;
  const body = await providerGet('gitee', url, fetchImpl);
  return readCommit(body);
}

function readCommit(body: Record<string, unknown>): { sha: string; message: string; author: string; committedAt: string } {
  const sha = typeof body.sha === 'string' ? body.sha : '';
  const commit = body.commit;
  if (!commit || typeof commit !== 'object') throw new HttpError(502, '代码托管平台返回的提交不完整', 'REPO_PROVIDER');
  const record = commit as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : '';
  const author = record.author;
  const authorRecord = author && typeof author === 'object' ? author as Record<string, unknown> : {};
  const name = typeof authorRecord.name === 'string' ? authorRecord.name : 'unknown';
  const date = typeof authorRecord.date === 'string' ? authorRecord.date : '';
  if (!/^[0-9a-f]{40}$/i.test(sha) && !/^[0-9a-f]{64}$/i.test(sha)) {
    throw new HttpError(502, '代码托管平台返回的提交不完整', 'REPO_PROVIDER');
  }
  const committedAt = new Date(date);
  if (Number.isNaN(committedAt.getTime())) throw new HttpError(502, '代码托管平台返回的提交不完整', 'REPO_PROVIDER');
  return { sha, message, author: name, committedAt: committedAt.toISOString() };
}

async function providerGet(provider: 'github' | 'gitee', url: string, fetchImpl: FetchLike, githubToken?: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json',
        'user-agent': '110lab-assessment',
        ...(provider === 'github' ? { 'x-github-api-version': '2022-11-28' } : {}),
        ...(provider === 'github' && githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
      },
    });
  } catch {
    throw new HttpError(502, '代码托管平台暂时无法访问', 'REPO_PROVIDER');
  }
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (response.status === 429 || (response.status === 403 && remaining === '0')) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(429, '代码托管平台请求过于频繁，请稍后再试', 'REPO_RATE_LIMIT');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(502, '代码托管平台返回了不受支持的重定向', 'REPO_REDIRECT');
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(400, '仓库不存在或不是公开仓库', 'REPO_NOT_FOUND');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    console.error(JSON.stringify({ component: 'repo', provider, status: response.status }));
    throw new HttpError(502, '代码托管平台暂时无法访问', 'REPO_PROVIDER');
  }
  const buffer = await readLimitedBody(response);
  try {
    const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('shape');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, '代码托管平台返回异常', 'REPO_PROVIDER');
  }
}

async function readLimitedBody(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 1_000_000) throw new HttpError(502, '代码托管平台返回异常', 'REPO_PROVIDER');
    return buffer;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1_000_000) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, '代码托管平台返回异常', 'REPO_PROVIDER');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, '代码托管平台暂时无法访问', 'REPO_PROVIDER');
  }
  return Buffer.concat(chunks);
}
