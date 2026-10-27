import {
  projectDigest,
  projectSyncInput,
  classificationId,
} from '../../server/modules/requirements/project-management.model';
import { PortalProjectService } from '../../server/modules/requirements/portal-project.service';
import { RequirementsQueryService } from '../../server/modules/requirements/requirements-query.service';
import type { WorkspaceOptions } from '../../shared/api.interface';
const id = '550e8400-e29b-41d4-a716-446655440000';
const input = { sourceProjectId: id, name: '新项目', summary: '项目简介' };
const row = { id, name: input.name, summary: input.summary };
function setup(results: unknown[][]) {
  const chain: Record<string, jest.Mock> = {};
  for (const k of [
    'select',
    'from',
    'where',
    'limit',
    'insert',
    'values',
    'onConflictDoNothing',
    'orderBy',
    'update',
    'set',
  ])
    chain[k] = jest.fn(() => chain);
  const execute = jest.fn();
  for (const value of results) execute.mockResolvedValueOnce(value);
  const database = {
    run: jest.fn((callback) => callback({ ...chain, execute })),
  };
  return {
    service: new PortalProjectService(database as never),
    database,
    execute,
    chain,
  };
}
describe('first-party portal project registration', () => {
  it('rejects caller-supplied permissions, origin and malformed IDs before any write', async () => {
    const { service, database } = setup([]);
    for (const invalid of [
      { ...input, sourceUrl: 'https://evil.test' },
      { ...input, roles: ['admin'] },
      { ...input, name: 'x\ny' },
      { ...input, sourceProjectId: 'bad' },
      { ...input, summary: '' },
    ])
      await expect(service.register(invalid)).rejects.toThrow();
    await expect(
      service.lookup({ sourceProjectId: id, owner: 'x' }),
    ).rejects.toThrow();
    expect(database.run).not.toHaveBeenCalled();
  });
  it('registers a stable ID with a server-derived source and safe project link', async () => {
    const { service, chain } = setup([[], [row]]);
    const result = await service.register(input);
    expect(result.projectId).toBe(id);
    expect(result.sourceProjectId).toBe(id);
    expect(new URL(result.projectUrl).searchParams.get('project')).toBe(
      '新项目',
    );
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        sourceUrl: 'https://internal.110-lab.cn/projects?project=' + id,
      }),
    );
    expect(chain.onConflictDoNothing).toHaveBeenCalled();
  });
  it('replays a matching source ID and rejects conflicting content without overwriting', async () => {
    const { service, chain } = setup([[], [row], [], [row]]);
    await expect(service.register(input)).resolves.toEqual(
      expect.objectContaining({ projectId: id }),
    );
    await expect(service.register({ ...input, name: 'Other' })).rejects.toThrow(
      '同一项目 ID',
    );
    expect(chain.onConflictDoNothing).toHaveBeenCalledTimes(2);
  });
  it('reports absent registrations as an explicit null rather than ambiguous 404', async () => {
    const { service } = setup([[], [row]]);
    await expect(service.lookup({ sourceProjectId: id })).resolves.toEqual({
      project: null,
    });
    await expect(service.lookup({ sourceProjectId: id })).resolves.toEqual({
      project: expect.objectContaining({ projectId: id }),
    });
  });
  it('refreshes project options from the registry without discarding Bitable choices', async () => {
    const names = jest
      .fn()
      .mockResolvedValueOnce(['新项目', '既有项目'])
      .mockResolvedValueOnce(['新项目', '新增项目']);
    const query = new RequirementsQueryService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      { names } as never,
    );
    const options = query as unknown as {
      options(fields: unknown[]): Promise<WorkspaceOptions>;
    };
    const fields = [{ name: '项目', options: [{ name: '既有项目' }] }];
    expect((await options.options(fields)).projects).toEqual([
      '既有项目',
      '新项目',
    ]);
    expect((await options.options(fields)).projects).toEqual([
      '既有项目',
      '新项目',
      '新增项目',
    ]);
    expect(names).toHaveBeenCalledTimes(2);
  });
});

const snapshot = {
  phase: 'active',
  archived: false,
  ownerName: '负责人',
  memberNames: ['成员'],
  application: '立项说明',
  reviewNote: '已通过',
  aliases: ['旧项目名'],
  links: { repository: '', requirements: '', docs: '', demo: '' },
  milestones: [],
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
};
describe('versioned project management', () => {
  it('preserves legitimate names that match Object prototype properties',async()=>{
    const {service}=setup([[],[]]);
    expect(await service.normalizeOptions(['constructor','toString','__proto__'])).toEqual(['constructor','toString','__proto__']);
  });
  it('accepts matching retries and rejects stale or equal-version changed payloads', async () => {
    const body = { ...input, revision: 2, snapshot };
    const digest = projectDigest(projectSyncInput.parse(body));
    const saved = { ...row, sourceRevision: 2, sourceDigest: digest };
    const { service, chain } = setup([
      [],
      [],
      [saved],
      [],
      [],
      [saved],
      [],
      [],
      [saved],
    ]);
    await expect(service.register(body)).resolves.toEqual(
      expect.objectContaining({ revision: 2, digest }),
    );
    await expect(service.register({ ...body, revision: 1 })).rejects.toThrow(
      '版本',
    );
    await expect(
      service.register({ ...body, summary: '冲突' }),
    ).rejects.toThrow('版本');
    expect(chain.update).toHaveBeenCalledTimes(3);
  });
  it('rejects dangerous links, unpaired versions, invented approval fields and blank ordinary summaries', () => {
    for (const body of [
      { ...input, snapshot },
      { ...input, revision: 1 },
      { ...input, revision: 1, snapshot: { ...snapshot, admin: true } },
      {
        ...input,
        revision: 1,
        snapshot: {
          ...snapshot,
          links: { ...snapshot.links, docs: 'javascript:alert(1)' },
        },
      },
      { ...input, summary: '' },
    ])
      expect(projectSyncInput.safeParse(body).success).toBe(false);
    expect(
      projectSyncInput.safeParse({
        ...input,
        summary: '',
        revision: 1,
        snapshot: { ...snapshot, phase: 'unconfigured' },
      }).success,
    ).toBe(true);
  });
  it('canonicalizes old classifications after rename without conflating ambiguous names', async () => {
    const { service } = setup([
      [{ ...row, name: '新名称', snapshotJson: JSON.stringify(snapshot) }],
    ]);
    expect(await service.normalization()).toEqual({
      新名称: '新名称',
      旧项目名: '新名称',
    });
    const other = setup([
      [
        { ...row, name: '新名称', snapshotJson: JSON.stringify(snapshot) },
        {
          ...row,
          id: '550e8400-e29b-41d4-a716-446655440001',
          name: '旧项目名',
        },
      ],
    ]);
    expect((await other.service.normalization())['旧项目名']).toBeUndefined();
  });
  it('uses stable option IDs and filters known names without mutating Feishu', async () => {
    const { database } = setup([[row]]);
    const feishu = {
      listFields: jest.fn().mockResolvedValue([
        {
          name: '项目',
          options: [
            { id: 'opt_1', name: '已有分类' },
            { id: 'opt_2', name: input.name },
          ],
        },
      ]),
    };
    process.env.FEISHU_REQUIREMENTS_TABLE = 'table-test';
    try {
      const service = new PortalProjectService(
        database as never,
        feishu as never,
      );
      expect(await service.catalog()).toEqual({
        categories: [{ id: classificationId('opt_1'), name: '已有分类' }],
      });
      expect(classificationId('opt_1')).toBe(classificationId('opt_1'));
    } finally {
      delete process.env.FEISHU_REQUIREMENTS_TABLE;
    }
  });
  it('reads project names and alias normalization from a single consistent registry read', async () => {
    const { service, database } = setup([[{ ...row, snapshotJson: JSON.stringify(snapshot) }]]);
    const catalog = await service.readCatalog();
    expect(catalog.names).toEqual(['新项目']);
    expect(catalog.normalization['旧项目名']).toBe('新项目');
    expect(database.run).toHaveBeenCalledTimes(1);
  });

});
