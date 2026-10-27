import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { GitHubPullRequestsService } from './github-pull-requests.service';
import { GitHubSyncService } from './github-sync.service';

export function verifyGitHubSignature(raw: Buffer, signature: string, secret: string): void {
  if (secret.length < 32) throw new ServiceUnavailableException('GitHub 回调尚未配置');
  if (!/^sha256=[a-f0-9]{64}$/u.test(signature)) throw new UnauthorizedException('GitHub 回调签名无效');
  const expected: Buffer = createHmac('sha256', secret).update(raw).digest();
  const provided: Buffer = Buffer.from(signature.slice(7), 'hex');
  if (!timingSafeEqual(expected, provided)) throw new UnauthorizedException('GitHub 回调签名无效');
}

const EVENTS: Set<string> = new Set(['pull_request','pull_request_review','pull_request_review_comment','issue_comment','check_run','check_suite','status','push','ping']);
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value.slice(0,100) : []; }

@Injectable()
export class GitHubWebhookService {
  constructor(private readonly github: GitHubPullRequestsService, private readonly sync: GitHubSyncService) {}

  async receive(raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>): Promise<{ duplicate: boolean; queued: number }> {
    if (!raw || !Buffer.isBuffer(raw)) throw new BadRequestException('GitHub 回调缺少原始请求体');
    verifyGitHubSignature(raw, typeof headers['x-hub-signature-256'] === 'string' ? headers['x-hub-signature-256'] : '', process.env.GITHUB_WEBHOOK_SECRET || '');
    const deliveryId: string = typeof headers['x-github-delivery'] === 'string' ? headers['x-github-delivery'] : '';
    const eventName: string = typeof headers['x-github-event'] === 'string' ? headers['x-github-event'] : '';
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(deliveryId) || !EVENTS.has(eventName)) throw new BadRequestException('GitHub 回调事件无效');
    let payload: Record<string, unknown>;
    try { payload = object(JSON.parse(raw.toString('utf8'))); } catch { throw new BadRequestException('GitHub 回调内容无效'); }
    const repository: string = String(object(payload.repository).full_name || '');
    if (repository.toLowerCase() !== this.github.repository().toLowerCase()) throw new ForbiddenException('GitHub 回调仓库不匹配');
    const installation: string = process.env.GITHUB_INSTALLATION_ID?.trim() || '';
    if (installation && String(object(payload.installation).id || '') !== installation) throw new ForbiddenException('GitHub 回调安装身份不匹配');
    const numbers: number[] = [];
    if (eventName === 'pull_request' || eventName.startsWith('pull_request_review')) numbers.push(Number(object(payload.pull_request).number));
    if (eventName === 'issue_comment' && object(payload.issue).pull_request) numbers.push(Number(object(payload.issue).number));
    const check: Record<string, unknown> = object(payload.check_run || payload.check_suite);
    for (const value of array(check.pull_requests)) numbers.push(Number(object(value).number));
    const branches: string[] = [];
    if (eventName === 'push' && typeof payload.ref === 'string' && payload.ref.startsWith('refs/heads/')) branches.push(payload.ref.slice(11));
    if (eventName === 'status') for (const branch of array(payload.branches)) branches.push(String(object(branch).name || ''));
    const checkBranch: unknown = check.head_branch || object(check.check_suite).head_branch;
    if (typeof checkBranch === 'string') branches.push(checkBranch);
    if (branches.length) numbers.push(...await this.sync.pullNumbersForBranches(branches));
    const unique: number[] = [...new Set(numbers.filter((number: number): boolean => Number.isSafeInteger(number) && number > 0))].sort((a: number,b: number): number => a-b);
    if (unique.length > 100) throw new BadRequestException('GitHub 回调影响范围过大');
    return this.sync.accept({ deliveryId, repository: this.github.repository(), eventName,
      action: String(payload.action || '').slice(0,80), payloadHash: createHash('sha256').update(raw).digest('hex'), pullNumbers: unique });
  }
}
