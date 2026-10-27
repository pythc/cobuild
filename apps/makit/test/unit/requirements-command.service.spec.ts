import type { AuthNPaasService } from '@lark-apaas/fullstack-nestjs-core';
import type {
  CurrentUserSummary,
  RequirementSummary,
  WorkspaceResponse,
} from '@shared/api.interface';
import type {
  BaseRecord,
  FeishuService,
} from '../../server/modules/requirements/feishu.service';
import { RequirementsCommandService } from '../../server/modules/requirements/requirements-command.service';
import type { RequirementsQueryService } from '../../server/modules/requirements/requirements-query.service';

const ACCESS = {
  assertCanCreate: jest.fn(),
  assertCanUpdate: jest.fn(),
  assertCanComment: jest.fn(),
  assertCanManageAcceptance: jest.fn(),
  assertCanManageRelations: jest.fn(),
  assertCanManageGroup: jest.fn(),
};
const ARCHIVE = {
  assertActive: jest.fn().mockResolvedValue(undefined),
  activeIds: jest.fn().mockResolvedValue(new Set<string>()),
  archive: jest.fn().mockResolvedValue({
    success: true,
    message: '需求已归档',
    recordId: 'rec_requirement',
    updatedFields: ['归档状态'],
  }),
  permanentlyDelete: jest.fn(),
};
const READINESS = { assertReady: jest.fn().mockResolvedValue(undefined) };
const AI_REVIEWS = {
  assertArtifactReady: jest.fn().mockResolvedValue(undefined),
  assertTransitionReady: jest.fn().mockResolvedValue(undefined),
  onRequirementCreated: jest.fn().mockResolvedValue(undefined),
  onRequirementUpdated: jest.fn().mockResolvedValue(undefined),
};

function commandService(
  feishu: FeishuService,
  query: RequirementsQueryService,
  authn: AuthNPaasService,
): RequirementsCommandService {
  query.requirementWithWorkflow ||= jest.fn(async (current, patch) => ({ ...current, type: patch?.type ?? current.type, iterationIds: patch?.iterationIds ?? current.iterationIds }));
  query.assertWorkflowVersion ||= jest.fn().mockResolvedValue(undefined);
  return new RequirementsCommandService(
    feishu,
    query,
    authn,
    ACCESS as never,
    ARCHIVE as never,
    READINESS as never,
    AI_REVIEWS as never,
  );
}

const CURRENT_USER: CurrentUserSummary = {
  miaodaUserId: 'miaoda-owner',
  employeeId: 'employee-owner',
  openId: 'ou_owner',
  name: '管理员',
};

function requirement(
  overrides: Partial<RequirementSummary> = {},
): RequirementSummary {
  return {
    id: 'rec_requirement',
    code: 'REQ-1',
    title: '测试需求',
    url: 'https://example.com/requirement',
    introduction: '',
    acceptanceCriteria: '',
    selfTestReport: '',
    defectCause: '',
    gitBranchName: '',
    githubPullRequestUrl: '',
    type: '产品需求',
    source: '产品规划',
    tags: [],
    status: '开发中',
    allowedStatuses: ['需求已评审', '开发中', '开发转测试'],
    priority: 'P1',
    project: '测试项目',
    iterationIds: ['rec_iteration'],
    iterationNames: ['测试迭代'],
    handlers: [{ id: 'ou_handler', name: '处理人' }],
    productOwners: [],
    developers: [],
    testers: [],
    foOwners: [],
    proposers: [],
    followers: [],
    releaseOwners: [],
    personnelUserIds: {
      handlers: [],
      productOwners: [],
      developers: [],
      testers: [],
      foOwners: [],
      proposers: [],
      followers: [],
      releaseOwners: [],
    },
    startAt: null,
    deadlineAt: null,
    developmentStartAt: null,
    developmentEndAt: null,
    testingAt: null,
    actualStartAt: null,
    actualTestingAt: null,
    actualReleaseAt: null,
    effort: null,
    latestProgress: '',
    blocked: false,
    blocker: '',
    updatedAt: null,
    updatedByName: '',
    groupChatId: '',
    groupLink: '',
    groupStatus: '未创建',
    isMine: true,
    risks: [],
    capabilities: {
      canUpdate: true,
      canArchive: true,
      canManageGroup: true,
      canManageAcceptance: true,
      canManageRelations: true,
      canComment: true,
    },
    ...overrides,
  };
}

function workspace(
  requirementInput: RequirementSummary | RequirementSummary[],
): WorkspaceResponse {
  const requirements: RequirementSummary[] = Array.isArray(requirementInput)
    ? requirementInput
    : [requirementInput];
  return {
    fetchedAt: new Date(0).toISOString(),
    currentUser: CURRENT_USER,
    stats: {
      total: 1,
      mine: 1,
      inProgress: 1,
      blocked: 0,
      overdue: 0,
      completed: 0,
    },
    iterations: [
      {
        id: 'rec_iteration',
        name: '测试迭代',
        status: '进行中',
        goal: '',
        owner: [],
        startAt: null,
        endAt: null,
        reviewAt: null,
        developmentAt: null,
        testingAt: null,
        releaseAt: null,
        requirementCount: requirements.length,
        completedCount: 0,
        completionRate: 0,
      },
    ],
    requirements,
    options: {
      statuses: [
        '新',
        '需求已评审',
        '开发中',
        '开发转测试',
        '测试中',
        '新建',
        '处理中',
        '已解决',
        '已验证',
        '已关闭',
        '重新打开',
        '已拒绝',
      ],
      priorities: ['P0', 'P1', 'P2', 'P3'],
      projects: ['测试项目', '新项目'],
      types: ['产品需求', '缺陷'],
      sources: ['产品规划'],
      tags: [],
    },
  };
}

function editContext(item: RequirementSummary) {
  const data: WorkspaceResponse = workspace(item);
  return { iterations: data.iterations, options: data.options };
}

describe('RequirementsCommandService collaboration safeguards', () => {
  const previousOwnerOpenId: string | undefined = process.env.OWNER_OPEN_ID;

  beforeEach(() => {
    process.env.OWNER_OPEN_ID = 'ou_owner';
    jest.clearAllMocks();
    AI_REVIEWS.assertTransitionReady.mockResolvedValue(undefined);
    AI_REVIEWS.onRequirementCreated.mockResolvedValue(undefined);
    AI_REVIEWS.onRequirementUpdated.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (previousOwnerOpenId === undefined) delete process.env.OWNER_OPEN_ID;
    else process.env.OWNER_OPEN_ID = previousOwnerOpenId;
  });

  describe('single iteration boundary across UI, MCP and queued writes', () => {
    function setup(iterationIds: string[] = ['rec_iteration']) {
      const item = requirement({ iterationIds, updatedAt: 1234 });
      const feishu = {
        createRecord: jest.fn(),
        updateRecord: jest.fn().mockResolvedValue({}),
        batchUpdateRecords: jest.fn().mockResolvedValue({}),
      };
      const query = {
        currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
        requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
        requirementByIdAs: jest.fn().mockResolvedValue(item),
        workspace: jest.fn().mockResolvedValue(workspace(item)),
        table: jest.fn((name: string) => name),
        invalidate: jest.fn(), invalidateRequirement: jest.fn(),
      };
      const service = commandService(
        feishu as unknown as FeishuService,
        query as unknown as RequirementsQueryService,
        {} as AuthNPaasService,
      );
      return { item, feishu, service };
    }

    it('rejects retired planning dates before any external write',async()=>{
      const {service,feishu,item}=setup();
      await expect(service.updateRequirement(item.id,{expectedUpdatedAt:1234,patch:{developmentStartAt:1700000000000}},{userId:'miaoda-owner',userName:'管理员'})).rejects.toThrow('日期字段已停用');
      expect(feishu.updateRecord).not.toHaveBeenCalled();
    });
    it('automatically starts a new development cycle and rejects client-supplied start times',async()=>{
      const {service,feishu,item}=setup();item.status='需求已评审';item.actualStartAt=1000;item.developers=[{id:'ou_developer',name:'虚构研发'}];
      await expect(service.updateRequirement(item.id,{expectedUpdatedAt:1234,patch:{actualStartAt:2000}},{userId:'miaoda-owner',userName:'管理员'})).rejects.toThrow('自动记录');
      expect(feishu.updateRecord).not.toHaveBeenCalled();
      await service.updateRequirement(item.id,{expectedUpdatedAt:1234,patch:{status:'开发中'}},{userId:'miaoda-owner',userName:'管理员'});
      expect(feishu.updateRecord.mock.calls[0][2]['实际开始时间']).toBeGreaterThan(1000);
    });

    it('rejects a create with multiple iterations before external writes or AI', async () => {
      const { service, feishu } = setup();
      await expect(
        service.createRequirement(
          { title: '测试', iterationIds: ['a', 'b'] },
          { userId: 'miaoda-owner', userName: '管理员' },
        ),
      ).rejects.toThrow('只能关联一个迭代');
      expect(feishu.createRecord).not.toHaveBeenCalled();
      expect(AI_REVIEWS.onRequirementCreated).not.toHaveBeenCalled();
    });

    it.each(['direct', 'preflight', 'worker'] as const)(
      'rejects multiple links at %s entrypoint',
      async (entry) => {
        const { service, feishu, item } = setup();
        const input = {
          expectedUpdatedAt: 1234,
          patch: { iterationIds: ['a', 'b'] },
        };
        const beforePersist = jest.fn();
        const result =
          entry === 'direct'
            ? service.updateRequirement(item.id, input, {
                userId: 'miaoda-owner',
                userName: '管理员',
              })
            : entry === 'preflight'
              ? service.preflightRequirementUpdateAs(
                  item.id,
                  input,
                  CURRENT_USER,
                )
              : service.updateRequirementAsWorker(
                  item.id,
                  input,
                  CURRENT_USER,
                  new Set(),
                  beforePersist,
                );
        await expect(result).rejects.toThrow('只能关联一个迭代');
        expect(feishu.updateRecord).not.toHaveBeenCalled();
        expect(beforePersist).not.toHaveBeenCalled();
      },
    );

    it('blocks a legacy conflict even when only another field is changed', async () => {
      const { service, feishu, item } = setup(['rec_iteration', 'rec_other']);
      await expect(
        service.preflightRequirementUpdateAs(
          item.id,
          { expectedUpdatedAt: 1234, patch: { priority: 'P2' } },
          CURRENT_USER,
        ),
      ).rejects.toThrow('只能关联一个迭代');
      expect(item.iterationIds).toEqual(['rec_iteration', 'rec_other']);
      expect(feishu.updateRecord).not.toHaveBeenCalled();
    });

    it.each([{ ids: [] }, { ids: ['rec_iteration'] }])(
      'allows explicit repair to $ids',
      async ({ ids }) => {
        const { service, feishu, item } = setup(['rec_iteration', 'rec_other']);
        await service.updateRequirement(
          item.id,
          { expectedUpdatedAt: 1234, patch: { iterationIds: ids } },
          { userId: 'miaoda-owner', userName: '管理员' },
        );
        expect(feishu.updateRecord).toHaveBeenCalledWith(
          'FEISHU_REQUIREMENTS_TABLE',
          item.id,
          expect.objectContaining({ 所属迭代: ids }),
          'user_id',
        );
      },
    );

    it('rejects an entire bulk batch before writing when a record still has conflicting iterations', async () => {
      const { service, feishu, item } = setup(['rec_iteration', 'rec_other']);
      await expect(
        service.bulkUpdateRequirements(
          {
            items: [{ recordId: item.id, expectedUpdatedAt: 1234 }],
            patch: { priority: 'P2' },
          },
          { userId: 'miaoda-owner', userName: '管理员' },
        ),
      ).rejects.toThrow('只能关联一个迭代');
      expect(feishu.batchUpdateRecords).not.toHaveBeenCalled();
    });

    it('rejects a bulk multi-iteration patch, including duplicate IDs', async () => {
      const { service, feishu, item } = setup();
      await expect(
        service.bulkUpdateRequirements(
          {
            items: [{ recordId: item.id, expectedUpdatedAt: 1234 }],
            patch: { iterationIds: ['rec_iteration', 'rec_iteration'] },
          },
          { userId: 'miaoda-owner', userName: '管理员' },
        ),
      ).rejects.toThrow('只能关联一个迭代');
      expect(feishu.batchUpdateRecords).not.toHaveBeenCalled();
    });
  });

  it('keeps the group created when link or welcome-message enrichment fails', async () => {
    const item: RequirementSummary = requirement();
    const updateRecord = jest.fn().mockResolvedValue({});
    const feishu = {
      updateRecord,
      createChat: jest.fn().mockResolvedValue('oc_created'),
      createPermanentChatLink: jest
        .fn()
        .mockRejectedValue(new Error('link unavailable')),
      sendGroupPost: jest
        .fn()
        .mockRejectedValue(new Error('message unavailable')),
    };
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      workspace: jest.fn().mockResolvedValue(workspace(item)),
      workspaceAs: jest.fn().mockResolvedValue(workspace(item)),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const authnService = {
      getBatchLarkUserIds: jest.fn(),
    };
    const service = commandService(
      feishu as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      authnService as unknown as AuthNPaasService,
    );

    const result = await service.runGroupAction(item.id, 'create', {
      userId: 'miaoda-owner',
      userName: '管理员',
    });

    expect(result.success).toBe(true);
    expect(feishu.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ name: item.title }),
    );
    expect(updateRecord).toHaveBeenCalledWith(
      'FEISHU_REQUIREMENTS_TABLE',
      item.id,
      expect.objectContaining({
        需求群ID: 'oc_created',
        拉群状态: '已创建',
        拉群时间: expect.any(Number),
        群成员同步时间: expect.any(Number),
      }),
      'user_id',
    );
    const failedWrites: unknown[] = updateRecord.mock.calls.filter(
      (call: unknown[]): boolean =>
        (call[2] as Record<string, unknown>)['拉群状态'] === '失败',
    );
    expect(failedWrites).toHaveLength(0);
  });

  it('deletes related records before deleting the requirement', async () => {
    const item: RequirementSummary = requirement();
    const recordsByTable: Record<string, BaseRecord[]> = {
      FEISHU_COMMENTS_TABLE: [
        {
          record_id: 'rec_comment',
          fields: { 需求: [{ record_id: item.id }] },
        },
      ],
      FEISHU_ACCEPTANCE_TABLE: [],
      FEISHU_RELATIONS_TABLE: [
        {
          record_id: 'rec_relation',
          fields: { 源需求: [{ record_id: item.id }] },
        },
      ],
      FEISHU_COLLABORATION_TABLE: [
        {
          record_id: 'rec_event',
          fields: { 需求: [{ record_id: item.id }] },
        },
      ],
    };
    const deleteRecord = jest.fn().mockResolvedValue(undefined);
    const feishu = {
      listRecords: jest.fn(
        (tableId: string): Promise<BaseRecord[]> =>
          Promise.resolve(recordsByTable[tableId] || []),
      ),
      deleteRecord,
    };
    const query = {
      requirementById: jest.fn().mockResolvedValue(item),
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const authnService = {
      getBatchLarkUserIds: jest.fn(),
    };
    const service = commandService(
      feishu as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      authnService as unknown as AuthNPaasService,
    );

    const result = await service.deleteRequirement(item.id, {
      userId: 'miaoda-owner',
      userName: '管理员',
    });

    expect(result.success).toBe(true);
    expect(ARCHIVE.archive).toHaveBeenCalledWith(
      item,
      expect.objectContaining(CURRENT_USER),
    );
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it('does not write or notify when an update contains no real change', async () => {
    const item: RequirementSummary = requirement({ updatedAt: 1234 });
    const updateRecord = jest.fn();
    const feishu = { updateRecord };
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
      requirementByIdAs: jest.fn().mockResolvedValue(item),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      feishu as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );

    const result = await service.updateRequirement(
      item.id,
      { expectedUpdatedAt: item.updatedAt, patch: { priority: item.priority } },
      { userId: 'miaoda-owner', userName: '管理员' },
    );

    expect(result.updatedFields).toEqual([]);
    expect(updateRecord).not.toHaveBeenCalled();
    expect(query.invalidate).not.toHaveBeenCalled();
  });

  it('records independent collaboration outcomes without rolling back a successful write', async () => {
    const item: RequirementSummary = requirement({ updatedAt: 1234 });
    const updateRecord = jest.fn().mockResolvedValue({});
    const createRecord = jest.fn().mockRejectedValue(new Error('history unavailable'));
    const query = {
      requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
      requirementByIdAs: jest.fn().mockResolvedValue(item),
      table: jest.fn((name: string): string => name), invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService({ updateRecord, createRecord } as unknown as FeishuService,
      query as unknown as RequirementsQueryService, {} as AuthNPaasService);
    AI_REVIEWS.onRequirementUpdated.mockRejectedValueOnce(new Error('review unavailable'));
    const result = await service.updateRequirementAsWorker(item.id,
      { expectedUpdatedAt: 1234, patch: { priority: 'P2' } }, CURRENT_USER,
      new Set(), async () => undefined, 'test-operation-id');
    expect(updateRecord).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.operationStages?.map((stage) => [stage.key, stage.status])).toEqual([
      ['write', 'succeeded'], ['history', 'failed'], ['review', 'failed'], ['notification', 'unknown'],
    ]);
    expect(createRecord.mock.calls[0][1]['事件键']).toBe('platform-operation:test-operation-id');
  });

  it('requires a defect cause when a defect moves to resolved', async () => {
    const item: RequirementSummary = requirement({
      type: '缺陷',
      status: '处理中',
      allowedStatuses: ['处理中', '已解决', '已拒绝'],
      updatedAt: 1234,
      testers: [],
    });
    const updateRecord = jest.fn();
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
      requirementByIdAs: jest.fn().mockResolvedValue(item),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      { updateRecord } as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );

    await expect(
      service.updateRequirement(
        item.id,
        {
          expectedUpdatedAt: item.updatedAt,
          intent: 'status-transition',
          patch: { status: '已解决' },
        },
        { userId: 'miaoda-owner', userName: '管理员' },
      ),
    ).rejects.toThrow('流转到“已解决”时必须填写缺陷原因');
    expect(updateRecord).not.toHaveBeenCalled();
    expect(AI_REVIEWS.assertTransitionReady).not.toHaveBeenCalled();
  });

  it('resolves a defect with only the current handler and defect cause', async () => {
    const item: RequirementSummary = requirement({
      type: '缺陷',
      status: '处理中',
      allowedStatuses: ['处理中', '已解决', '已拒绝'],
      updatedAt: 1234,
      testers: [],
    });
    const updateRecord = jest.fn().mockResolvedValue({});
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
      requirementByIdAs: jest.fn().mockResolvedValue(item),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      { updateRecord } as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );

    await service.updateRequirement(
      item.id,
      {
        expectedUpdatedAt: item.updatedAt,
        intent: 'status-transition',
        patch: {
          status: '已解决',
          defectCause: '租约到期后旧 Worker 仍写入结果',
        },
      },
      { userId: 'miaoda-owner', userName: '管理员' },
    );

    expect(updateRecord).toHaveBeenCalledWith(
      'FEISHU_REQUIREMENTS_TABLE',
      item.id,
      expect.objectContaining({
        状态: '已解决',
        缺陷原因: '租约到期后旧 Worker 仍写入结果',
      }),
      'user_id',
    );
    expect(AI_REVIEWS.assertTransitionReady).not.toHaveBeenCalled();
  });

  it('requires a completed delivery review when development hands off to testing', async () => {
    const item: RequirementSummary = requirement({
      updatedAt: 1234,
      testers: [{ id: 'ou_tester', name: '测试人员' }],
    });
    const updateRecord = jest.fn();
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
      requirementByIdAs: jest.fn().mockResolvedValue(item),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      { updateRecord } as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );
    AI_REVIEWS.assertTransitionReady.mockRejectedValueOnce(
      new Error('交付准备评审尚未通过'),
    );

    await expect(
      service.updateRequirement(
        item.id,
        {
          expectedUpdatedAt: item.updatedAt,
          patch: {
            status: '开发转测试',
            githubPullRequestUrl: 'https://github.com/pythc/repo/pull/1',
          },
        },
        { userId: 'miaoda-owner', userName: '管理员' },
      ),
    ).rejects.toThrow('交付准备评审尚未通过');
    expect(updateRecord).not.toHaveBeenCalled();
  });

  it('requires a GitHub pull request link before development hands off to testing', async () => {
    const item: RequirementSummary = requirement({
      updatedAt: 1234,
      selfTestReport: '自测通过',
      testers: [{ id: 'ou_tester', name: '测试人员' }],
    });
    const updateRecord = jest.fn();
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
      requirementByIdAs: jest.fn().mockResolvedValue(item),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      { updateRecord } as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );

    await expect(
      service.updateRequirement(
        item.id,
        {
          expectedUpdatedAt: item.updatedAt,
          patch: { status: '开发转测试' },
        },
        { userId: 'miaoda-owner', userName: '管理员' },
      ),
    ).rejects.toThrow('开发转测试前必须填写 GitHub 合并请求链接');
    expect(updateRecord).not.toHaveBeenCalled();
  });

  it('writes the status after the delivery review gate passes', async () => {
    const item: RequirementSummary = requirement({
      updatedAt: 1234,
      testers: [{ id: 'ou_tester', name: '测试人员' }],
    });
    const updateRecord = jest.fn().mockResolvedValue({});
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
      requirementByIdAs: jest.fn().mockResolvedValue(item),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      { updateRecord } as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );

    await service.updateRequirement(
      item.id,
      {
        expectedUpdatedAt: item.updatedAt,
        patch: {
          status: '开发转测试',
          githubPullRequestUrl: 'https://github.com/pythc/repo/pull/1',
        },
      },
      { userId: 'miaoda-owner', userName: '管理员' },
    );

    expect(updateRecord).toHaveBeenCalledWith(
      'FEISHU_REQUIREMENTS_TABLE',
      item.id,
      expect.objectContaining({
        状态: '开发转测试',
        'GitHub 合并请求链接': {
          link: 'https://github.com/pythc/repo/pull/1',
          text: 'https://github.com/pythc/repo/pull/1',
        },
      }),
      'user_id',
    );
    expect(AI_REVIEWS.assertTransitionReady).toHaveBeenCalledWith(
      item,
      '开发转测试',
    );
  });

  it('keeps a stale multi-field transition from overwriting concurrent edits', async () => {
    const item: RequirementSummary = requirement({
      status: '新',
      allowedStatuses: ['新', '需求已评审'],
      updatedAt: 1234,
    });
    const updateRecord = jest.fn().mockResolvedValue({});
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
      requirementByIdAs: jest
        .fn()
        .mockResolvedValue({ ...item, updatedAt: 2345 }),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      { updateRecord } as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );

    await expect(
      service.updateRequirement(
        item.id,
        {
          expectedUpdatedAt: item.updatedAt,
          intent: 'status-transition',
          patch: {
            status: '需求已评审',
            introduction: '<p>需求背景</p>',
            acceptanceCriteria: '验收条件',
          },
        },
        { userId: 'miaoda-owner', userName: '管理员' },
      ),
    ).rejects.toThrow('需求刚刚发生了冲突变更');

    expect(updateRecord).not.toHaveBeenCalled();
  });

  it('supports removing one collaboration member by writing the remaining lark ids', async () => {
    const item: RequirementSummary = requirement({ updatedAt: 1234 });
    const updateRecord = jest.fn().mockResolvedValue({});
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
      requirementByIdAs: jest.fn().mockResolvedValue(item),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      { updateRecord } as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );

    await service.updateRequirement(
      item.id,
      {
        expectedUpdatedAt: item.updatedAt,
        patch: { handlerLarkUserIds: ['employee-remaining'] },
      },
      { userId: 'miaoda-owner', userName: '管理员' },
    );

    expect(updateRecord).toHaveBeenCalledWith(
      'FEISHU_REQUIREMENTS_TABLE',
      item.id,
      expect.objectContaining({
        当前处理人: [{ id: 'employee-remaining' }],
      }),
      'user_id',
    );
  });

  it('normalizes employee IDs from native tickets before creating an open_id group', async () => {
    const item=requirement({type:'工单',handlers:[{id:'employee-handler',name:'处理人'}],proposers:[{id:'employee-owner',name:'管理员'}]});
    const feishu={getUserByEmployeeId:jest.fn(async (id:string)=>({employeeId:id,openId:id==='employee-handler'?'ou_handler':'ou_owner',name:id})),updateRecord:jest.fn(),createChat:jest.fn(async()=> 'oc_ticket'),createPermanentChatLink:jest.fn(),sendGroupPost:jest.fn()};
    const query={requirementByIdAs:jest.fn(async()=>item),table:jest.fn((n:string)=>n),invalidate:jest.fn()};
    await commandService(feishu as any,query as any,{} as any).runGroupActionAs(item.id,'create',CURRENT_USER);
    expect(feishu.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        memberIds: ['ou_owner', 'ou_handler'],
        name: `【${item.priority}工单】${item.title}`,
        description: `工单讨论群：${item.title}`,
      }),
    );
    expect(feishu.getUserByEmployeeId).toHaveBeenCalledTimes(2);
  });
  it('rejects inconsistent member mappings before any group write', async () => {
    const item=requirement({type:'工单',handlers:[{id:'employee-handler',name:'处理人'}]});
    const feishu={getUserByEmployeeId:jest.fn(async()=>({employeeId:'wrong',openId:'ou_wrong'})),updateRecord:jest.fn(),createChat:jest.fn()};
    const query={requirementByIdAs:jest.fn(async()=>item)};
    await expect(commandService(feishu as any,query as any,{} as any).runGroupActionAs(item.id,'create',CURRENT_USER)).rejects.toThrow('成员身份');
    expect(feishu.updateRecord).not.toHaveBeenCalled();expect(feishu.createChat).not.toHaveBeenCalled();
  });
  it('creates defects in the defect workflow at the new status', async () => {
    const item: RequirementSummary = requirement();
    const createRecord = jest
      .fn()
      .mockResolvedValue({ record_id: 'rec_defect' });
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      requirementEditContext: jest.fn().mockResolvedValue(editContext(item)),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      { createRecord } as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );

    await service.createRequirement(
      { title: '登录失败', type: '缺陷', status: '已关闭' },
      { userId: 'miaoda-owner', userName: '管理员' },
    );

    expect(createRecord).toHaveBeenCalledWith(
      'FEISHU_REQUIREMENTS_TABLE',
      expect.objectContaining({ 状态: '新建', 需求类型: '缺陷' }),
      'user_id',
    );
  });

  it('preflights every item before issuing one batch update', async () => {
    const first: RequirementSummary = requirement({
      id: 'rec_first',
      priority: 'P1',
      updatedAt: 100,
    });
    const second: RequirementSummary = requirement({
      id: 'rec_second',
      priority: 'P2',
      updatedAt: 200,
    });
    const batchUpdateRecords = jest.fn().mockResolvedValue([]);
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      workspace: jest.fn().mockResolvedValue(workspace([first, second])),
      workspaceAs: jest.fn().mockResolvedValue(workspace([first, second])),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      { batchUpdateRecords } as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );

    const result = await service.bulkUpdateRequirements(
      {
        items: [
          { recordId: first.id, expectedUpdatedAt: first.updatedAt },
          { recordId: second.id, expectedUpdatedAt: second.updatedAt },
        ],
        patch: { priority: 'P1' },
      },
      { userId: 'miaoda-owner', userName: '管理员' },
    );

    expect(result.affectedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(batchUpdateRecords).toHaveBeenCalledTimes(1);
    expect(batchUpdateRecords).toHaveBeenCalledWith(
      'FEISHU_REQUIREMENTS_TABLE',
      [
        expect.objectContaining({
          recordId: second.id,
          fields: expect.objectContaining({ 优先级: 'P1' }),
        }),
      ],
      'user_id',
    );
  });

  it('rejects a stale batch before writing any record', async () => {
    const item: RequirementSummary = requirement({ updatedAt: 200 });
    const batchUpdateRecords = jest.fn();
    const query = {
      currentUser: jest.fn().mockResolvedValue(CURRENT_USER),
      workspace: jest.fn().mockResolvedValue(workspace(item)),
      workspaceAs: jest.fn().mockResolvedValue(workspace(item)),
      table: jest.fn((name: string): string => name),
      invalidate: jest.fn(), invalidateRequirement: jest.fn(),
    };
    const service = commandService(
      { batchUpdateRecords } as unknown as FeishuService,
      query as unknown as RequirementsQueryService,
      { getBatchLarkUserIds: jest.fn() } as unknown as AuthNPaasService,
    );

    await expect(
      service.bulkUpdateRequirements(
        {
          items: [{ recordId: item.id, expectedUpdatedAt: 100 }],
          patch: { priority: 'P0' },
        },
        { userId: 'miaoda-owner', userName: '管理员' },
      ),
    ).rejects.toThrow('已被其他人更新');
    expect(batchUpdateRecords).not.toHaveBeenCalled();
  });
});
