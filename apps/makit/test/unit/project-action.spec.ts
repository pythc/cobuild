import { createHmac } from 'node:crypto';
import { ProjectActionService } from '../../server/modules/requirements/project-action.service';
const actor = {
  miaodaUserId: 'member',
  employeeId: 'employee-1',
  openId: 'ou_verified',
  name: '测试',
};
const projectId = '10000000-0000-4000-8000-000000000001',
  requestId = '20000000-0000-4000-8000-000000000002';
describe('Makit project action proxy', () => {
  const env = { ...process.env },
    fetcher = global.fetch;
  afterEach(() => {
    process.env = { ...env };
    global.fetch = fetcher;
  });
  it('derives stable subject from authenticated employee identity and signs the exact request body', async () => {
    process.env.PORTAL_PROJECT_BRIDGE_SECRET = 'fixture-signing-secret-'.repeat(
      3,
    );
    const projectSubject = jest
      .fn()
      .mockResolvedValue('tenant:on_verified12345');
    const service = new ProjectActionService({ projectSubject } as never);
    const mock = jest.fn().mockResolvedValue(Response.json({ id: projectId }));
    global.fetch = mock;
    await service.execute(actor, { projectId, requestId, action: 'read' });
    expect(projectSubject).toHaveBeenCalledWith('employee-1');
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe(
      'https://internal.110-lab.cn/api/workspace/project-actions',
    );
    expect(JSON.parse(init.body).subject).toBe('tenant:on_verified12345');
    expect(init.redirect).toBe('error');
    expect(init.headers['x-project-signature']).toBe(
      createHmac('sha256', process.env.PORTAL_PROJECT_BRIDGE_SECRET)
        .update(init.body)
        .digest('hex'),
    );
  });
  it('rejects client-supplied identity or unconfigured connections without network access', async () => {
    const service = new ProjectActionService({} as never);
    global.fetch = jest.fn();
    await expect(
      service.execute(actor, {
        projectId,
        requestId,
        action: 'read',
        subject: 'forged',
      }),
    ).rejects.toThrow('参数无效');
    delete process.env.PORTAL_PROJECT_BRIDGE_SECRET;
    await expect(
      service.execute(actor, { projectId, requestId, action: 'read' }),
    ).rejects.toThrow('连接尚未配置');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('keeps permission and revision conflict errors actionable instead of claiming success', async () => {
    process.env.PORTAL_PROJECT_BRIDGE_SECRET = 'fixture-signing-secret-'.repeat(
      3,
    );
    const service = new ProjectActionService({
      projectSubject: async () => 'tenant:on_verified12345',
    } as never);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        Response.json({ error: '内容已更新' }, { status: 409 }),
      );
    await expect(
      service.execute(actor, {
        projectId,
        requestId,
        action: 'knowledge_link',
        input: { revision: 1, url: '' },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
