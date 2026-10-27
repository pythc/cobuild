import { WorkspaceViewsService } from '../../server/modules/workspace-views/workspace-views.service';
import { RequirementAccessService } from '../../server/modules/requirements/requirement-access.service';
import type { CurrentUserSummary } from '../../shared/api.interface';
import type { WorkspaceSavedViewInput } from '../../shared/workspace-efficiency';

const actor = (roles: string[] = []): CurrentUserSummary =>
  ({
    miaodaUserId: '185000000000000001',
    name: '测试用户',
    employeeId: 'employee1',
    openId: 'ou_test',
    roles,
  }) as CurrentUserSummary;
const row = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  ownerUserId: '185000000000000001',
  scope: 'personal',
  name: '我的视图',
  configJson: '{"query":{"mineOnly":true}}',
  version: 1,
};
const input: WorkspaceSavedViewInput = {
  name: '我的视图',
  scope: 'personal',
  config: { query: { mineOnly: true } },
};

function setup(results: unknown[][]) {
  const chain: Record<string, jest.Mock> = {};
  for (const name of [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'insert',
    'values',
    'returning',
    'update',
    'set',
    'delete',
  ])
    chain[name] = jest.fn(() => chain);
  const execute = jest.fn();
  for (const result of results) execute.mockResolvedValueOnce(result);
  const database = {
    run: jest.fn((callback) => callback({ ...chain, execute })),
  };
  const service = new WorkspaceViewsService(
    database as never,
    new RequirementAccessService(),
  );
  return { service, chain, database };
}

describe('server-side saved view permissions and versions', () => {
  it('denies unauthenticated access before reading storage', async () => {
    const { service, database } = setup([]);
    await expect(
      service.list({ miaodaUserId: '' } as CurrentUserSummary),
    ).rejects.toThrow('请先登录');
    expect(database.run).not.toHaveBeenCalled();
  });
  it('returns personal and team edit permissions independently', async () => {
    const { service } = setup([
      [row, { ...row, id: 'other', ownerUserId: 'other', scope: 'team' }],
    ]);
    const result = await service.list(actor(['operations_viewer']));
    expect(result.canManageTeamViews).toBe(true);
    expect(result.items.map((item) => item.canEdit)).toEqual([true, true]);
  });
  it('allows an ordinary member to maintain a team view', async () => {
    const { service, database } = setup([[{ ...row, scope: 'team' }]]);
    await expect(
      service.save(actor(), { ...input, scope: 'team' }),
    ).resolves.toEqual(expect.objectContaining({ canEdit: true }));
    expect(database.run).toHaveBeenCalled();
  });
  it('uses the server actor for ownership, not a supplied owner', async () => {
    const { service, chain } = setup([[row]]);
    await service.save(actor(), {
      ...input,
      ownerUserId: 'forged',
    } as WorkspaceSavedViewInput);
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: actor().miaodaUserId,
        scope: 'personal',
      }),
    );
  });
  it('requires a matching version and never silently overwrites', async () => {
    const { service } = setup([[row], []]);
    await expect(
      service.save(actor(), { ...input, expectedVersion: 1 }, row.id),
    ).rejects.toThrow('视图已被更新');
  });
  it('rejects scope changes rather than silently sharing a private view', async () => {
    const { service } = setup([[row]]);
    await expect(
      service.save(
        actor(['admin']),
        { ...input, scope: 'team', expectedVersion: 1 },
        row.id,
      ),
    ).rejects.toThrow('视图范围不能');
  });
  it('checks the version again on delete', async () => {
    const { service } = setup([[row], []]);
    await expect(service.remove(actor(), row.id, 1)).rejects.toThrow(
      '视图已被更新',
    );
  });
});
