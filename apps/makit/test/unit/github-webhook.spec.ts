import { createHmac } from 'node:crypto';
import {
  GitHubWebhookService,
  verifyGitHubSignature,
} from '../../server/modules/pull-requests/github-webhook.service';
describe('GitHub callback trust and scope', () => {
  const secret = 's'.repeat(32),
    oldSecret = process.env.GITHUB_WEBHOOK_SECRET,
    oldInstallation = process.env.GITHUB_INSTALLATION_ID;
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    process.env.GITHUB_INSTALLATION_ID = '42';
  });
  afterEach(() => {
    if (oldSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = oldSecret;
    if (oldInstallation === undefined)
      delete process.env.GITHUB_INSTALLATION_ID;
    else process.env.GITHUB_INSTALLATION_ID = oldInstallation;
  });
  const signature = (raw: Buffer) =>
    'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const fixture = () => {
    const sync = {
      accept: jest.fn().mockResolvedValue({ duplicate: false, queued: 1 }),
      pullNumbersForBranches: jest.fn().mockResolvedValue([7, 7]),
    };
    return {
      sync,
      service: new GitHubWebhookService(
        { repository: () => 'org/repo' } as never,
        sync as never,
      ),
    };
  };
  const body = (patch = {}) =>
    Buffer.from(
      JSON.stringify({
        repository: { full_name: 'org/repo' },
        installation: { id: 42 },
        pull_request: { number: 7 },
        ...patch,
      }),
    );
  const headers = (raw: Buffer, event = 'pull_request') => ({
    'x-hub-signature-256': signature(raw),
    'x-github-delivery': 'delivery-1',
    'x-github-event': event,
  });
  it('verifies raw bytes, not a parsed/reformatted body', () => {
    const raw = Buffer.from('{"a": 1}');
    expect(() =>
      verifyGitHubSignature(raw, signature(raw), secret),
    ).not.toThrow();
    expect(() =>
      verifyGitHubSignature(Buffer.from('{"a":1}'), signature(raw), secret),
    ).toThrow();
    expect(() => verifyGitHubSignature(raw, signature(raw), '')).toThrow();
  });
  it('queues only affected PR, without GitHub mutation inline', async () => {
    const { sync, service } = fixture(),
      raw = body();
    await service.receive(raw, headers(raw));
    expect(sync.accept).toHaveBeenCalledWith(
      expect.objectContaining({
        pullNumbers: [7],
        repository: 'org/repo',
        deliveryId: 'delivery-1',
      }),
    );
  });
  it.each([
    { repository: { full_name: 'evil/repo' } },
    { installation: { id: 3 } },
  ])('rejects signed but wrong trust scope %j', async (patch) => {
    const { sync, service } = fixture(),
      raw = body(patch);
    await expect(service.receive(raw, headers(raw))).rejects.toThrow();
    expect(sync.accept).not.toHaveBeenCalled();
  });
  it('branch affected PRs deduplicate; issue comments do not create fake PRs', async () => {
    const { sync, service } = fixture(),
      raw = body({ ref: 'refs/heads/dev/test' });
    await service.receive(raw, headers(raw, 'push'));
    expect(sync.accept).toHaveBeenCalledWith(
      expect.objectContaining({ pullNumbers: [7] }),
    );
    const issue = body({ issue: { number: 7 } });
    await service.receive(issue, headers(issue, 'issue_comment'));
    expect(sync.accept).toHaveBeenLastCalledWith(
      expect.objectContaining({ pullNumbers: [] }),
    );
  });
});
