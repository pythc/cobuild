import {
  defaultIterationConfiguration,
  iterationConfigurationErrors,
  type IterationConfiguration,
} from '../../shared/iteration-workflow';
import { IterationConfigurationStore } from '../../server/modules/requirements/iteration-configuration.store';
import { IterationSettingsService } from '../../server/modules/requirements/iteration-settings.service';
import { RequirementAccessService } from '../../server/modules/requirements/requirement-access.service';
import { RequirementsCommandService } from '../../server/modules/requirements/requirements-command.service';
import { RequirementAiReviewService } from '../../server/modules/requirements/requirement-ai-review.service';
import { RequirementReleaseReadinessService } from '../../server/modules/requirements/requirement-release-readiness.service';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type {
  CurrentUserSummary,
  RequirementSummary,
} from '../../shared/api.interface';

const admin = {
  miaodaUserId: 'test-admin',
  name: '测试管理员',
  roles: ['admin'],
  employeeId: 'test-employee',
} as CurrentUserSummary;
const simpleConfig = (): IterationConfiguration => {
  const config = defaultIterationConfiguration();
  config.workflows.requirement = {
    statuses: ['新', '开发中', '已发布'],
    transitions: [
      {
        from: '新',
        to: '开发中',
        requiredFields: ['handlers'],
        reviews: [],
        releaseChecks: [],
        assigneeRole: 'developers',
      },
      {
        from: '开发中',
        to: '已发布',
        requiredFields: ['handlers'],
        reviews: [],
        releaseChecks: [],
        assigneeRole: 'releaseOwners',
      },
    ],
  };
  return config;
};
const version = (configuration = simpleConfig(), v = 1) => ({
  version: v,
  publishedAt: '2026-09-07T00:00:00.000Z',
  publishedBy: '测试管理员',
  configuration,
});
const req = (overrides: Partial<RequirementSummary> = {}) =>
  ({
    id: 'test-req',
    title: '测试',
    code: 'REQ-TEST',
    type: '产品需求',
    status: '新',
    iterationIds: ['test-iteration'],
    handlers: [{ id: 'test-user', name: '测试' }],
    testers: [],
    developers: [],
    releaseOwners: [],
    productOwners: [],
    introduction: '',
    acceptanceCriteria: '',
    selfTestReport: '',
    defectCause: '',
    gitBranchName: '',
    githubPullRequestUrl: '',
    latestProgress: '',
    updatedAt: 1,
    ...overrides,
  }) as RequirementSummary;

describe('iteration configuration validation', () => {
  it('preserves the existing normal and defect defaults', () =>
    expect(
      iterationConfigurationErrors(defaultIterationConfiguration()),
    ).toEqual([]));
  it('allows a compact workflow without reports or reviews', () =>
    expect(iterationConfigurationErrors(simpleConfig())).toEqual([]));
  it.each([
    [
      'missing handlers',
      (c: IterationConfiguration) => {
        c.workflows.requirement.transitions[0].requiredFields = [];
      },
    ],
    [
      'missing initial',
      (c: IterationConfiguration) => {
        c.workflows.requirement.statuses.shift();
      },
    ],
    [
      'unknown state',
      (c: IterationConfiguration) => {
        c.workflows.requirement.statuses.push('自由文本');
      },
    ],
    [
      'dead end',
      (c: IterationConfiguration) => {
        c.workflows.requirement.transitions.pop();
      },
    ],
    [
      'duplicate edge',
      (c: IterationConfiguration) => {
        c.workflows.requirement.transitions.push(
          c.workflows.requirement.transitions[0],
        );
      },
    ],
    [
      'review without material',
      (c: IterationConfiguration) => {
        c.workflows.requirement.transitions[0].reviews = [
          'technical_stability',
        ];
      },
    ],
    [
      'defect review',
      (c: IterationConfiguration) => {
        c.workflows.defect.transitions[0].reviews = ['clarity'];
      },
    ],
    [
      'release gate outside release',
      (c: IterationConfiguration) => {
        c.workflows.requirement.transitions[0].releaseChecks = [
          'github_checks',
        ];
      },
    ],
    [
      'invalid milestone',
      (c: IterationConfiguration) => {
        c.milestones.push({ id: 'x', name: '', dueAt: 'invalid' });
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const config = simpleConfig();
    mutate(config);
    expect(iterationConfigurationErrors(config).length).toBeGreaterThan(0);
  });
  it.each([
    null,
    [],
    {},
    { version: 2 },
    { version: 1, workflows: {}, milestones: [] },
  ])('rejects malformed input safely: %j', (input) =>
    expect(iterationConfigurationErrors(input).length).toBeGreaterThan(0),
  );
  it('rejects inherited keys without throwing', () => {
    const c = simpleConfig();
    (c.workflows.requirement.transitions[0].reviews as string[]) = [
      'constructor',
    ];
    expect(iterationConfigurationErrors(c).length).toBeGreaterThan(0);
  });
});

describe('configuration storage and publication', () => {
  it('reads only published columns through the detached worker executor with stable aliases', async () => {
    const database = drizzle.mock();
    const execute = jest.fn().mockResolvedValue([
      {
        iterationId: 'test-iteration',
        publishedJson: JSON.stringify(version()),
      },
    ]);
    const run = jest.fn((operation) =>
      operation({ select: database.select.bind(database), execute }),
    );
    const store = new IterationConfigurationStore(
      {} as never,
      { run } as never,
    );
    const result = await store.publishedMap('test-iteration');
    expect(result.get('test-iteration')?.version).toBe(1);
    const compiled = new PgDialect().sqlToQuery(
      execute.mock.calls[0][0].getSQL(),
    );
    expect(compiled.sql).toContain('as "iterationId"');
    expect(compiled.sql).toContain('as "publishedJson"');
    expect(compiled.sql).not.toMatch(/draft_json|history_json/);
    expect(compiled.params).toEqual(['test-iteration']);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid version numbers and corrupt history without overwriting it', async () => {
    const db = { update: jest.fn() };
    const store = new IterationConfigurationStore(db as never, {} as never);
    expect(() =>
      store.published({
        publishedJson: JSON.stringify(version(simpleConfig(), 0)),
      }),
    ).toThrow('无效');
    jest.spyOn(store, 'read').mockResolvedValue({
      revision: 1,
      historyJson: '{}',
      publishedJson: null,
    } as never);
    await expect(
      store.save('test', 1, simpleConfig(), '管理员'),
    ).rejects.toThrow('版本记录无效');
    expect(db.update).not.toHaveBeenCalled();
  });
  it('decorates only the published workflow and the correct iteration', () => {
    const store = new IterationConfigurationStore({} as never, {} as never);
    const item = req();
    store.decorate(item, new Map([['test-iteration', version()]]));
    expect(item.allowedStatuses).toEqual(['开发中']);
    expect(item.workflow?.version).toBe(1);
    const unconfigured = req({ iterationIds: ['other'] });
    store.decorate(unconfigured, new Map([['test-iteration', version()]]));
    expect(unconfigured.workflow).toBeUndefined();
  });
  it('fails closed on corrupt published data', () => {
    const store = new IterationConfigurationStore({} as never, {} as never);
    expect(() => store.published({ publishedJson: '{' } as never)).toThrow(
      '无法读取',
    );
    expect(() =>
      store.published({
        publishedJson: JSON.stringify({ version: 1, configuration: {} }),
      } as never),
    ).toThrow('无效');
  });
  it('does not publish a saved draft and atomically rejects an insert collision', async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const values = jest
      .fn()
      .mockReturnValue({ onConflictDoNothing: () => ({ returning }) });
    const store = new IterationConfigurationStore(
      { insert: () => ({ values }) } as never,
      {} as never,
    );
    jest.spyOn(store, 'read').mockResolvedValue(null);
    await expect(store.save('test', 0, simpleConfig())).rejects.toThrow(
      '配置已被修改',
    );
    expect(values.mock.calls[0][0].publishedJson).toBeNull();
  });
  it('rejects stale revisions before issuing an update', async () => {
    const update = jest.fn();
    const store = new IterationConfigurationStore(
      { update } as never,
      {} as never,
    );
    jest.spyOn(store, 'read').mockResolvedValue({ revision: 3 } as never);
    await expect(store.save('test', 2, simpleConfig())).rejects.toThrow(
      '配置已被修改',
    );
    expect(update).not.toHaveBeenCalled();
  });
  it('rejects a concurrent update that wins after the read', async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const store = new IterationConfigurationStore(
      {
        update: () => ({ set: () => ({ where: () => ({ returning }) }) }),
      } as never,
      {} as never,
    );
    jest.spyOn(store, 'read').mockResolvedValue({
      revision: 2,
      publishedJson: null,
      historyJson: '[]',
    } as never);
    await expect(store.save('test', 2, simpleConfig())).rejects.toThrow(
      '配置已被修改',
    );
  });
  it('creates a new version when restoring an older configuration, preserving history', async () => {
    const set = jest.fn().mockReturnValue({
      where: () => ({ returning: async () => [{ id: 'test' }] }),
    });
    const store = new IterationConfigurationStore(
      { update: () => ({ set }) } as never,
      {} as never,
    );
    jest.spyOn(store, 'read').mockResolvedValue({
      revision: 5,
      publishedJson: JSON.stringify(version(simpleConfig(), 2)),
      historyJson: JSON.stringify([
        version(defaultIterationConfiguration(), 1),
        version(simpleConfig(), 2),
      ]),
    } as never);
    await store.save('test', 5, defaultIterationConfiguration(), '测试管理员');
    expect(JSON.parse(set.mock.calls[0][0].publishedJson).version).toBe(3);
    expect(JSON.parse(set.mock.calls[0][0].historyJson)).toHaveLength(3);
  });
  it('denies anonymous users before data reads', async () => {
    const service = new IterationSettingsService(
      {} as never,
      {} as never,
      new RequirementAccessService(),
    );
    await expect(
      service.get('test', { ...admin, miaodaUserId: '', roles: ['editor'] }),
    ).rejects.toThrow('请先登录');
  });
  it('blocks publication with in-use removed states and legacy multi-iteration records', async () => {
    const store = new IterationConfigurationStore({} as never, {} as never);
    jest.spyOn(store, 'read').mockResolvedValue(null);
    const query = {
      workspaceAs: jest.fn().mockResolvedValue({
        iterations: [{ id: 'test-iteration' }],
        requirements: [
          req({ status: '测试中' }),
          req({
            code: 'REQ-MULTI',
            iterationIds: ['test-iteration', 'other'],
          }),
        ],
      }),
    };
    const service = new IterationSettingsService(
      store,
      query as never,
      new RequirementAccessService(),
    );
    const result = await service.impact(
      'test-iteration',
      simpleConfig(),
      admin,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(query.workspaceAs).toHaveBeenCalledWith(admin, true);
  });
});

describe('configured rules apply to real command paths', () => {
  function setup(
    config = simpleConfig(),
    overrides: Partial<RequirementSummary> = {},
  ) {
    const store = new IterationConfigurationStore({} as never, {} as never);
    const item = req(overrides);
    store.decorate(item, new Map([['test-iteration', version(config)]]));
    const feishu = {
      updateRecord: jest.fn().mockResolvedValue({}),
      createRecord: jest.fn().mockResolvedValue({}),
    };
    const query = {
      requirementEditContext: jest.fn().mockResolvedValue({
        iterations: [{ id: 'test-iteration' }],
        options: { statuses: config.workflows.requirement.statuses },
      }),
      requirementByIdAs: jest.fn().mockResolvedValue(item),
      requirementWithWorkflow: jest.fn().mockResolvedValue(item),
      assertWorkflowVersion: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn(),
      invalidateRequirement: jest.fn(),
      table: jest.fn().mockReturnValue('test-table'),
    };
    const ai = {
      assertArtifactReady: jest.fn().mockResolvedValue(undefined),
      assertTransitionReady: jest.fn().mockResolvedValue(undefined),
      onRequirementUpdated: jest.fn().mockResolvedValue(undefined),
    };
    const access = { assertCanUpdate: jest.fn() };
    const archive = { assertActive: jest.fn() };
    const readiness = { assertReady: jest.fn().mockResolvedValue(undefined) };
    const service = new RequirementsCommandService(
      feishu as never,
      query as never,
      {} as never,
      access as never,
      archive as never,
      readiness as never,
      ai as never,
    );
    return { service, feishu, query, ai, item, readiness, access };
  }
  it('permits a custom skip transition without default developer/report gates', async () => {
    const { service, feishu } = setup();
    await service.updateRequirementAs(
      'test-req',
      { expectedUpdatedAt: 1, patch: { status: '开发中' } },
      admin,
    );
    expect(feishu.updateRecord).toHaveBeenCalledWith(
      'test-table',
      'test-req',
      expect.objectContaining({ 状态: '开发中' }),
      'user_id',
    );
  });
  it('validates configured reports in preflight without writing or notifying', async () => {
    const c = simpleConfig();
    c.workflows.requirement.transitions[0].requiredFields.push(
      'technical_design',
    );
    const { service, ai, feishu } = setup(c);
    ai.assertArtifactReady.mockRejectedValue(new Error('请先上传技术方案'));
    await expect(
      service.preflightRequirementUpdateAs(
        'test-req',
        { expectedUpdatedAt: 1, patch: { status: '开发中' } },
        admin,
      ),
    ).rejects.toThrow('请先上传技术方案');
    expect(feishu.updateRecord).not.toHaveBeenCalled();
  });
  it('requires a handler even on a minimal workflow', async () => {
    const { service, feishu } = setup(simpleConfig(), { handlers: [] });
    await expect(
      service.updateRequirementAs(
        'test-req',
        { expectedUpdatedAt: 1, patch: { status: '开发中' } },
        admin,
      ),
    ).rejects.toThrow('当前处理人');
    expect(feishu.updateRecord).not.toHaveBeenCalled();
  });
  it('checks the new material when content and status change together, before any writes', async () => {
    const c = simpleConfig();
    c.workflows.requirement.transitions[0].requiredFields.push(
      'introduction',
      'acceptanceCriteria',
    );
    c.workflows.requirement.transitions[0].reviews.push('clarity');
    const { service, ai, feishu } = setup(c, {
      introduction: '旧内容',
      acceptanceCriteria: '原验收标准',
    });
    ai.assertTransitionReady.mockRejectedValue(
      new Error('请先完成新内容的评审'),
    );
    await expect(
      service.updateRequirementAs(
        'test-req',
        {
          expectedUpdatedAt: 1,
          patch: {
            status: '开发中',
            introduction: '新内容',
            acceptanceCriteria: '新验收标准',
          },
        },
        admin,
      ),
    ).rejects.toThrow('新内容');
    expect(ai.assertTransitionReady).toHaveBeenCalledWith(
      expect.objectContaining({
        introduction: '新内容',
        acceptanceCriteria: '新验收标准',
      }),
      '开发中',
    );
    expect(feishu.updateRecord).not.toHaveBeenCalled();
  });
  it('fails closed if a configured AI gate has no review for its current material', async () => {
    const c = simpleConfig();
    c.workflows.requirement.transitions[0].reviews = ['clarity'];
    c.workflows.requirement.transitions[0].requiredFields.push(
      'introduction',
      'acceptanceCriteria',
    );
    const { item } = setup(c, {
      introduction: '清晰的需求',
      acceptanceCriteria: '明确的验收标准',
    });
    const database = drizzle.mock();
    const execute = jest.fn().mockResolvedValue([]);
    const run = jest.fn((operation) =>
      operation({ select: database.select.bind(database), execute }),
    );
    const service = new RequirementAiReviewService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { run } as never,
    );
    await expect(service.assertTransitionReady(item, '开发中')).rejects.toThrow(
      '请先完成',
    );
    const compiled = new PgDialect().sqlToQuery(
      execute.mock.calls[0][0].getSQL(),
    );
    expect(compiled.sql).toContain('"source_hash"');
    expect(compiled.params).toEqual(
      expect.arrayContaining(['test-req', 'clarity']),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('rejects a disallowed target', async () => {
    const { service, feishu } = setup();
    await expect(
      service.updateRequirementAs(
        'test-req',
        { expectedUpdatedAt: 1, patch: { status: '已发布' } },
        admin,
      ),
    ).rejects.toThrow('未允许');
    expect(feishu.updateRecord).not.toHaveBeenCalled();
  });
  it('rejects an old job when the rules change before persistence', async () => {
    const { service, query, feishu } = setup();
    query.assertWorkflowVersion.mockRejectedValue(new Error('迭代规则已更新'));
    await expect(
      service.updateRequirementAs(
        'test-req',
        { expectedUpdatedAt: 1, patch: { status: '开发中' } },
        admin,
      ),
    ).rejects.toThrow('规则已更新');
    expect(feishu.updateRecord).not.toHaveBeenCalled();
  });
  it('rejects moving a status that is unsupported by the target workflow', async () => {
    const { service, feishu } = setup(simpleConfig(), { status: '测试中' });
    await expect(
      service.updateRequirementAs(
        'test-req',
        { expectedUpdatedAt: 1, patch: { latestProgress: '测试' } },
        admin,
      ),
    ).rejects.toThrow('目标迭代');
    expect(feishu.updateRecord).not.toHaveBeenCalled();
  });
  it('does not fetch artifacts or AI results for disabled review gates', async () => {
    const db = { execute: jest.fn() };
    const service = new RequirementAiReviewService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const { item } = setup();
    await service.assertTransitionReady(item, '开发中');
    expect(db.execute).not.toHaveBeenCalled();
  });
  it('does not contact Base or GitHub for disabled release checks', async () => {
    const { item } = setup(simpleConfig(), { status: '开发中' });
    const feishu = { searchRecords: jest.fn() };
    const db = { select: jest.fn() };
    const refresh = { refresh: jest.fn() };
    const service = new RequirementReleaseReadinessService(
      db as never,
      feishu as never,
      {} as never,
      refresh as never,
    );
    const result = await service.assertReady(item, '已发布');
    expect(result.ready).toBe(true);
    expect(result.checks).toEqual([]);
    expect(feishu.searchRecords).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(refresh.refresh).not.toHaveBeenCalled();
  });
  it('admits a valid transition without running slow release checks twice', async () => {
    const { service, readiness, feishu } = setup(simpleConfig(), {
      status: '开发中',
    });
    readiness.assertReady.mockRejectedValue(new Error('发布检查失败'));
    const result = await service.preflightRequirementUpdateAs(
      'test-req',
      { expectedUpdatedAt: 1, patch: { status: '已发布' } },
      admin,
    );
    expect(result.success).toBe(true);
    expect(readiness.assertReady).not.toHaveBeenCalled();
    expect(feishu.updateRecord).not.toHaveBeenCalled();
  });
  it('still rejects an unauthorized transition before admission', async () => {
    const { service, readiness, feishu, access } = setup(simpleConfig(), {
      status: '开发中',
    });
    access.assertCanUpdate.mockImplementation(() => {
      throw new Error('无权限');
    });
    await expect(
      service.preflightRequirementUpdateAs(
        'test-req',
        { expectedUpdatedAt: 1, patch: { status: '已发布' } },
        admin,
      ),
    ).rejects.toThrow('无权限');
    expect(readiness.assertReady).not.toHaveBeenCalled();
    expect(feishu.updateRecord).not.toHaveBeenCalled();
  });
  it.each(['direct', 'worker'] as const)(
    'enforces authoritative release checks before %s writes or notifications',
    async (entry) => {
      const { service, readiness, feishu, ai, item } = setup(simpleConfig(), {
        status: '开发中',
      });
      readiness.assertReady.mockRejectedValue(new Error('验收项全部完成'));
      const input = { expectedUpdatedAt: 1, patch: { status: '已发布' } };
      const beforePersist = jest.fn();
      await expect(
        entry === 'worker'
          ? service.updateRequirementAsWorker(
              item.id,
              input,
              admin,
              new Set(),
              beforePersist,
            )
          : service.updateRequirementAs(item.id, input, admin),
      ).rejects.toThrow('验收项全部完成');
      expect(readiness.assertReady).toHaveBeenCalledTimes(1);
      expect(readiness.assertReady).toHaveBeenCalledWith(
        item,
        '已发布',
        input.patch,
      );
      expect(beforePersist).not.toHaveBeenCalled();
      expect(feishu.updateRecord).not.toHaveBeenCalled();
      expect(feishu.createRecord).not.toHaveBeenCalled();
      expect(ai.onRequirementUpdated).not.toHaveBeenCalled();
    },
  );
  it('ignores disabled acceptance checks while enforcing remaining published checks', async () => {
    const config = simpleConfig();
    config.workflows.requirement.transitions[1].releaseChecks = [
      'self_test_report',
      'testers',
    ];
    const { item } = setup(config, {
      status: '开发中',
      selfTestReport: '自测通过',
      testers: [{ id: 'test-person', name: '测试人员' }],
    });
    const feishu = { searchRecords: jest.fn() };
    const service = new RequirementReleaseReadinessService(
      {} as never,
      feishu as never,
      {} as never,
      {} as never,
    );
    const result = await service.assertReady(item, '已发布');
    expect(result.ready).toBe(true);
    expect(result.checks.map((check) => check.key)).toEqual([
      'self_test_report',
      'testers',
    ]);
    expect(feishu.searchRecords).not.toHaveBeenCalled();
    await expect(
      service.assertReady({ ...item, selfTestReport: '' }, '已发布'),
    ).rejects.toThrow('自测报告');
  });
});
