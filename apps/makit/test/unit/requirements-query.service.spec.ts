import { selectRequirementList } from '../../shared/requirement-list';
import type { AuthNPaasService } from '@lark-apaas/fullstack-nestjs-core';
import type {
  BaseField,
  BaseRecord,
} from '../../server/modules/requirements/feishu.service';
import type { FeishuService } from '../../server/modules/requirements/feishu.service';
import { RequirementsQueryService } from '../../server/modules/requirements/requirements-query.service';
import { RequirementAccessService } from '../../server/modules/requirements/requirement-access.service';
import type { ServiceRoleDatabaseExecutor } from '../../server/database/service-role-database.executor';

const TABLES: Readonly<Record<string, string>> = {
  FEISHU_REQUIREMENTS_TABLE: 'requirements',
  FEISHU_ITERATIONS_TABLE: 'iterations',
  FEISHU_COMMENTS_TABLE: 'comments',
  FEISHU_ACCEPTANCE_TABLE: 'acceptance',
  FEISHU_RELATIONS_TABLE: 'relations',
  FEISHU_COLLABORATION_TABLE: 'events',
};

function requirementRecord(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): BaseRecord {
  return {
    record_id: id,
    fields: {
      需求编号: `REQ-${id}`,
      需求: title,
      需求类型: '产品需求',
      需求来源: '产品规划',
      状态: '开发中',
      优先级: 'P2',
      项目: 'AI批改系统',
      所属迭代: [{ record_id: 'iteration-1' }],
      当前处理人: [{ id: 'ou_handler', name: '处理人' }],
      产品人员: [{ id: 'ou_product', name: '产品' }],
      研发人员: [{ id: 'ou_developer', name: '研发' }],
      测试人员: [{ id: 'ou_tester', name: '测试' }],
      FO: [{ id: 'ou_fo', name: 'FO 成员' }],
      更新时间: 1_700_000_000_000,
      ...overrides,
    },
  };
}

function iterationRecord(overrides: Record<string, unknown> = {}): BaseRecord {
  return {
    record_id: 'iteration-1',
    fields: {
      迭代名称: '批改系统1.0.1',
      状态: '进行中',
      开始时间: 1_700_000_000_000,
      ...overrides,
    },
  };
}

function requirementFields(): BaseField[] {
  return [
    {
      id: 'status',
      name: '状态',
      type: '3',
      options: [{ name: '开发中' }, { name: '测试中' }],
    },
    {
      id: 'priority',
      name: '优先级',
      type: '3',
      options: [{ name: 'P0' }, { name: 'P2' }],
    },
    {
      id: 'project',
      name: '项目',
      type: '3',
      options: [{ name: 'AI批改系统' }],
    },
  ];
}

function createService(
  records: BaseRecord[],
  iterationOverrides: Record<string, unknown> = {},
  serviceDatabase?: ServiceRoleDatabaseExecutor,
) {
  const listRecords = jest.fn(
    async (tableId: string): Promise<BaseRecord[]> => {
      if (tableId === TABLES.FEISHU_REQUIREMENTS_TABLE) return records;
      if (tableId === TABLES.FEISHU_ITERATIONS_TABLE) {
        return [iterationRecord(iterationOverrides)];
      }
      return [];
    },
  );
  const getRecord = jest.fn(
    async (_tableId: string, recordId: string): Promise<BaseRecord> => {
      const record: BaseRecord | undefined = records.find(
        (item: BaseRecord): boolean => item.record_id === recordId,
      );
      if (!record) throw new Error('not found');
      return record;
    },
  );
  const searchRecords = jest.fn().mockResolvedValue([]);
  const feishu = {
    listRecords,
    searchRecords,
    listFields: jest.fn().mockResolvedValue(requirementFields()),
    getRecord,
    getOpenIdByEmployeeId: jest.fn().mockResolvedValue('ou_handler'),
  };
  const authn = {
    getCurrentUserLarkUserId: jest.fn().mockResolvedValue('employee-1'),
  };
  const db = {
    execute: jest.fn().mockResolvedValue([]),
  };
  const service = new RequirementsQueryService(
    feishu as unknown as FeishuService,
    authn as unknown as AuthNPaasService,
    new RequirementAccessService(),
    db as never,
    { publishedMap: jest.fn().mockResolvedValue(new Map()), decorate: jest.fn(), assertVersion: jest.fn() } as never,
    serviceDatabase,
  );
  return { service, listRecords, searchRecords, getRecord, feishu, db };
}

const identity = { userId: 'miaoda-1', userName: '当前用户' };

describe('RequirementsQueryService paged queries', () => {
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    Object.entries(TABLES).forEach(([name, value]: [string, string]): void => {
      previousEnv[name] = process.env[name];
      process.env[name] = value;
    });
  });

  afterAll(() => {
    Object.keys(TABLES).forEach((name: string): void => {
      const value: string | undefined = previousEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  });

  it('finds iteration requirements with list and lightweight-search linked cell formats', async () => {
    for (const cell of [{link_record_ids:['iteration-1']},[{link_record_ids:['iteration-1']}],{record_ids:['iteration-1']}]) {
      const {service}=createService([requirementRecord('recFormat','测试需求',{所属迭代:cell})]);
      const page=await service.requirementsPage(identity,{iterationId:'iteration-1',includeContent:false},false);
      expect(page.total).toBe(1);expect(page.items[0].iterationIds).toEqual(['iteration-1']);
    }
  });

  it('retires only requirement planning dates, preserving iteration dates, automatic dates and ticket deadlines', async () => {
    const {service}=createService([
      requirementRecord('recNormal','常规需求',{开始时间:111,截止时间:222,开发预计启动时间:333,开发预计结束时间:444,预计提测时间:555,实际开始时间:666}),
      requirementRecord('recTicket','工单',{需求类型:'工单',截止时间:777}),
    ]);
    const data=await service.workspace(identity,false);
    expect(data.iterations[0].startAt).toBe(1700000000000);
    const normal=data.requirements.find(r=>r.id==='recNormal')!;
    expect([normal.startAt,normal.deadlineAt,normal.developmentStartAt,normal.developmentEndAt,normal.testingAt]).toEqual([null,null,null,null,null]);
    expect(normal.actualStartAt).toBe(666);expect(data.requirements.find(r=>r.id==='recTicket')?.deadlineAt).toBe(777);
  });

  it('uses worker identity only for the archive read and preserves actor capabilities', async () => {
    let inDatabase = false;
    const execute = jest.fn().mockResolvedValue([]);
    const run = jest.fn(async (operation: (db: unknown) => Promise<unknown>) => {
      inDatabase = true;
      try { return await operation({ execute }); }
      finally { inDatabase = false; }
    });
    const { service, db } = createService([], {}, { run } as never);
    const actor = await service.currentUser(identity);
    const read = jest.spyOn(service, 'requirementByIdAs').mockImplementation(async () => {
      expect(inDatabase).toBe(false);
      return { id: 'rec_test' } as never;
    });
    await expect(service.requirementByIdForWorker('rec_test', actor))
      .resolves.toEqual({ id: 'rec_test' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.execute).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith('rec_test', actor, new Set());
  });

  it('does not read Feishu material for an archived requirement', async () => {
    const execute = jest.fn().mockResolvedValue([{ requirement_id: 'rec_archived' }]);
    const run = jest.fn(async (operation: (db: unknown) => Promise<unknown>) => operation({ execute }));
    const { service, getRecord } = createService([], {}, { run } as never);
    const actor = await service.currentUser(identity);
    await expect(service.requirementByIdForWorker('rec_archived', actor)).rejects.toThrow('未找到该需求');
    expect(getRecord).not.toHaveBeenCalled();
  });

  it('fails closed when worker identity is unavailable without falling back to request DB', async () => {
    const { service, db, getRecord } = createService([]);
    const actor = await service.currentUser(identity);
    await expect(service.requirementByIdForWorker('rec_test', actor)).rejects.toThrow('后台数据库执行身份尚未就绪');
    expect(db.execute).not.toHaveBeenCalled();
    expect(getRecord).not.toHaveBeenCalled();
  });

  it('filters, sorts and returns only the requested page', async () => {
    const records: BaseRecord[] = [
      requirementRecord('1', '低优先级需求', { 优先级: 'P2' }),
      requirementRecord('2', '高优先级需求', { 优先级: 'P0' }),
      requirementRecord('3', '其他状态需求', { 状态: '测试中' }),
      requirementRecord('4', '阻塞需求', {
        优先级: 'P0',
        是否阻塞: true,
      }),
    ];
    const { service } = createService(records);

    const result = await service.requirementsPage(
      identity,
      {
        page: 1,
        pageSize: 2,
        status: '开发中',
        sortBy: 'priority',
        sortOrder: 'asc',
      },
      false,
    );

    expect(result.total).toBe(3);
    expect(result.pageCount).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.title)).toEqual([
      '高优先级需求',
      '阻塞需求',
    ]);
  });

  it('caps page size and clamps an out-of-range page', async () => {
    const { service } = createService([
      requirementRecord('1', '需求一'),
      requirementRecord('2', '需求二'),
    ]);

    const result = await service.requirementsPage(
      identity,
      { page: 3, pageSize: 500 },
      false,
    );

    expect(result.pageSize).toBe(100);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.items).toHaveLength(2);
  });

  it('treats only the current handler as my work', async () => {
    const { service } = createService([
      requirementRecord('1', '我负责处理', {
        当前处理人: [{ id: 'ou_handler', name: '当前用户' }],
      }),
      requirementRecord('2', '我只是产品协作人', {
        当前处理人: [{ id: 'ou_other', name: '其他处理人' }],
        产品人员: [{ id: 'ou_handler', name: '当前用户' }],
      }),
    ]);

    const result = await service.requirementsPage(
      identity,
      { page: 1, pageSize: 25, mineOnly: true },
      false,
    );

    expect(result.items.map((item) => item.title)).toEqual(['我负责处理']);
  });

  it('finds participation across all requirement roles by identity', async () => {
    const roles = [
      '当前处理人', '提出人', '产品人员', '研发人员', '测试人员',
      'FO', '发布负责人', '关注人',
    ];
    const records = roles.map((role, index) =>
      requirementRecord(String(index), role, {
        当前处理人: [{ id: 'ou_other', name: '当前用户' }],
        [role]: [{ id: 'ou_handler', name: '当前用户' }],
      }),
    );
    const { service } = createService([
      ...records,
      requirementRecord('other', '同名成员参与的需求', {
        当前处理人: [{ id: 'ou_other', name: '当前用户' }],
      }),
    ]);

    const result = await service.requirementsPage(
      identity,
      { participatingOnly: true },
      false,
    );
    expect(result.items.map((item) => item.title).sort()).toEqual(roles.sort());
  });

  it('keeps legacy status filter links working during migration', async () => {
    const { service } = createService([
      requirementRecord('1', '历史已评审需求', { 状态: '已评审' }),
    ]);

    const result = await service.requirementsPage(
      identity,
      { page: 1, pageSize: 25, status: '已评审' },
      false,
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status).toBe('需求已评审');
  });

  it('places the current user first when grouping by a person field', async () => {
    const { service } = createService([
      requirementRecord('1', '其他人需求', {
        当前处理人: [{ id: 'ou_other', name: '阿明' }],
      }),
      requirementRecord('2', '我的需求', {
        当前处理人: [{ id: 'ou_handler', name: '当前用户' }],
      }),
    ]);

    const result = await service.requirementsPage(
      identity,
      { page: 1, pageSize: 25, groupBy: 'handler' },
      false,
    );

    expect(result.groups?.map((group) => group.label)).toEqual([
      '当前用户',
      '阿明',
    ]);
  });

  it('supports filtering and grouping requirements by FO', async () => {
    const { service } = createService([
      requirementRecord('1', 'FO 负责需求', {
        FO: [{ id: 'ou_fo_target', name: '目标 FO' }],
      }),
      requirementRecord('2', '其他 FO 需求', {
        FO: [{ id: 'ou_fo_other', name: '其他 FO' }],
      }),
    ]);

    const filtered = await service.requirementsPage(
      identity,
      { page: 1, pageSize: 25, foOwnerId: 'ou_fo_target', groupBy: 'fo' },
      false,
    );

    expect(filtered.items.map((item) => item.title)).toEqual(['FO 负责需求']);
    expect(filtered.items[0]?.foOwners).toEqual([
      { id: 'ou_fo_target', name: '目标 FO' },
    ]);
    expect(filtered.groups?.map((group) => group.label)).toEqual(['目标 FO']);
  });

  it('orders status groups by workflow rather than alphabetically', async () => {
    const { service } = createService([
      requirementRecord('1', '测试需求', { 状态: '测试中' }),
      requirementRecord('2', '新需求', { 状态: '新' }),
      requirementRecord('3', '已评审需求', { 状态: '需求已评审' }),
    ]);

    const result = await service.requirementsPage(
      identity,
      { page: 1, pageSize: 25, groupBy: 'status' },
      false,
    );

    expect(result.groups?.map((group) => group.label)).toEqual([
      '新',
      '需求已评审',
      '测试中',
    ]);
  });

  it('bounds a single large group by the requested row page size', async () => {
    const records: BaseRecord[] = Array.from(
      { length: 5 },
      (_value: unknown, index: number): BaseRecord =>
        requirementRecord(String(index + 1), `需求${index + 1}`),
    );
    const { service } = createService(records);

    const firstPage = await service.requirementsPage(
      identity,
      { page: 1, pageSize: 2, groupBy: 'status' },
      false,
    );
    const secondPage = await service.requirementsPage(
      identity,
      { page: 2, pageSize: 2, groupBy: 'status' },
      false,
    );

    expect(firstPage.total).toBe(5);
    expect(firstPage.rowTotal).toBe(5);
    expect(firstPage.groupCount).toBe(1);
    expect(firstPage.pageCount).toBe(3);
    expect(firstPage.groups).toHaveLength(1);
    expect(firstPage.groups?.[0]?.items).toHaveLength(2);
    expect(firstPage.groups?.[0]?.totalCount).toBe(5);
    expect(secondPage.groups?.[0]?.key).toBe(firstPage.groups?.[0]?.key);
    expect(secondPage.groups?.[0]?.items).toHaveLength(2);
    expect(secondPage.groups?.[0]?.totalCount).toBe(5);
  });

  it('splits a page across groups without exceeding the row page size', async () => {
    const records: BaseRecord[] = [
      requirementRecord('1', 'P0 需求一', { 优先级: 'P0' }),
      requirementRecord('2', 'P0 需求二', { 优先级: 'P0' }),
      requirementRecord('3', 'P2 需求一', { 优先级: 'P2' }),
      requirementRecord('4', 'P2 需求二', { 优先级: 'P2' }),
    ];
    const { service } = createService(records);

    const firstPage = await service.requirementsPage(
      identity,
      { page: 1, pageSize: 3, groupBy: 'priority' },
      false,
    );
    const secondPage = await service.requirementsPage(
      identity,
      { page: 2, pageSize: 3, groupBy: 'priority' },
      false,
    );
    const firstPageRows: number =
      firstPage.groups?.reduce(
        (count: number, group): number => count + group.items.length,
        0,
      ) || 0;
    const secondPageRows: number =
      secondPage.groups?.reduce(
        (count: number, group): number => count + group.items.length,
        0,
      ) || 0;

    expect(firstPageRows).toBe(3);
    expect(secondPageRows).toBe(1);
    expect(firstPage.groups).toHaveLength(2);
    expect(firstPage.groups?.[1]?.key).toBe(secondPage.groups?.[0]?.key);
    expect(firstPage.groups?.[1]?.totalCount).toBe(2);
    expect(secondPage.groups?.[0]?.totalCount).toBe(2);
    expect(firstPage.total).toBe(4);
    expect(firstPage.rowTotal).toBe(4);
    expect(firstPage.groupCount).toBe(2);
    expect(firstPage.pageCount).toBe(2);
  });

  it('clamps an out-of-range grouped page to the final row page', async () => {
    const { service } = createService([
      requirementRecord('1', '需求一'),
      requirementRecord('2', '需求二'),
      requirementRecord('3', '需求三'),
    ]);

    const result = await service.requirementsPage(
      identity,
      { page: 99, pageSize: 2, groupBy: 'status' },
      false,
    );

    expect(result.page).toBe(2);
    expect(result.pageCount).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups?.[0]?.items).toHaveLength(1);
  });

  it('returns workspace metadata without embedding the requirement list', async () => {
    const { service } = createService([requirementRecord('1', '需求一')]);

    const summary = await service.workspaceSummary(identity, false);

    expect(summary.stats.total).toBe(1);
    expect(summary.iterations[0]?.requirementCount).toBe(1);
    expect(summary.peopleOptions.handlers).toEqual([
      { id: 'ou_handler', name: '处理人' },
    ]);
    expect(Object.hasOwn(summary, 'requirements')).toBe(false);
  });

  it('loads filtered detail data and reads the main requirement only once', async () => {
    const { service, listRecords, searchRecords, getRecord, feishu } =
      createService([
        requirementRecord('target', '目标需求'),
        requirementRecord('other', '其他需求'),
      ]);

    const detail = await service.detail('target', identity);

    expect(detail.requirement.id).toBe('target');
    expect(detail.requirement.handlers).toEqual([
      { id: 'ou_handler', name: '处理人' },
    ]);
    expect(detail.requirement.personnelUserIds.handlers).toEqual([
      'ou_handler',
    ]);
    expect(detail.requirement.isMine).toBe(true);
    expect(getRecord).toHaveBeenCalledTimes(1);
    expect(getRecord).toHaveBeenCalledWith('requirements', 'target', 'user_id');
    expect(listRecords).not.toHaveBeenCalledWith('requirements');
    expect(listRecords).not.toHaveBeenCalledWith('comments');
    expect(listRecords).not.toHaveBeenCalledWith('acceptance');
    expect(listRecords).not.toHaveBeenCalledWith('relations');
    expect(listRecords).not.toHaveBeenCalledWith('events');
    expect(feishu.getOpenIdByEmployeeId).toHaveBeenCalledTimes(1);
    expect(feishu.getOpenIdByEmployeeId).toHaveBeenCalledWith('employee-1');
    expect(searchRecords).toHaveBeenCalledTimes(4);
    expect(searchRecords).toHaveBeenCalledWith(
      'comments',
      {
        conjunction: 'and',
        conditions: [
          {
            fieldName: '需求',
            operator: 'contains',
            value: ['target'],
          },
        ],
      },
      'user_id',
    );
    expect(searchRecords).toHaveBeenCalledWith(
      'relations',
      {
        conjunction: 'or',
        conditions: [
          {
            fieldName: '源需求',
            operator: 'contains',
            value: ['target'],
          },
          {
            fieldName: '目标需求',
            operator: 'contains',
            value: ['target'],
          },
        ],
      },
      'user_id',
    );
  });

  it('decorates detail capabilities with resolved identity and platform roles', async () => {
    const { service, feishu } = createService([
      requirementRecord('target', '目标需求', {
        当前处理人: [{ id: 'ou_other', name: '其他处理人' }],
      }),
    ]);

    const detail = await service.detail('target', {
      ...identity,
      roles: ['admin'],
    });

    expect(feishu.getOpenIdByEmployeeId).toHaveBeenCalledWith('employee-1');
    expect(detail.requirement.capabilities.canUpdate).toBe(true);
    expect(detail.requirement.capabilities.canArchive).toBe(true);
  });

  it('uses the iteration end date when no release milestone is configured', async () => {
    const { service } = createService(
      [requirementRecord('target', '目标需求')],
      {
        结束时间: 1_700_086_400_000,
        发布时间: null,
      },
    );

    const result = await service.requirementsPage(identity, {}, false);

    expect(result.items[0]?.risks).toContain('发布里程碑逾期');
  });

  it('excludes archived requirements from lists and direct reads', async () => {
    const { service, db } = createService([
      requirementRecord('archived', '已归档需求'),
      requirementRecord('active', '活跃需求'),
    ]);
    db.execute.mockResolvedValue([{ requirement_id: 'archived' }]);

    const page = await service.requirementsPage(identity, {}, false);

    expect(page.items.map((item) => item.id)).toEqual(['active']);
    await expect(service.requirementById('archived', identity)).rejects.toThrow(
      '未找到该需求',
    );
  });
  it('returns a complete lightweight index, preserving authoritative iteration links beyond page one', async () => {
    const records = Array.from({ length: 137 }, (_, index) => requirementRecord(String(index), `需求${index}`, {
      需求介绍: '正文'.repeat(1000), 验收标准: '验收'.repeat(1000), 自测报告: '报告', 缺陷原因: '原因',
    }));
    const { service, listRecords } = createService(records);
    const snapshot = await service.browserWorkspace(identity, false);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.requirements).toHaveLength(137);
    expect(snapshot.requirements[0].introductionPreview).toHaveLength(200);
    expect(snapshot.requirements.every((item) => item.contentOmitted && !item.introduction && !item.acceptanceCriteria && !item.selfTestReport && !item.defectCause)).toBe(true);
    const selected = selectRequirementList(snapshot, { search: '需求136', iterationId: 'iteration-1' });
    expect(selected.items.map((item) => item.id)).toEqual(['136']);
    expect(selected.items[0].iterationNames).toEqual(['批改系统1.0.1']);
    expect(listRecords).toHaveBeenCalledWith('requirements', undefined);
  });

  it('uses identical browser and API filter, sort and grouped-row pagination rules', async () => {
    const { service } = createService(Array.from({ length: 61 }, (_, i) => requirementRecord(String(i), `需求${i}`, {
      当前处理人: [{ id: 'ou_handler', name: '处理人' }, { id: `ou_${i % 3}`, name: `同事${i % 3}` }],
      优先级: i % 2 ? 'P0' : 'P2', 是否阻塞: i % 5 === 0,
    })));
    const snapshot = await service.browserWorkspace(identity, false);
    for (const filter of [
      { search: '同事1', page: 2, pageSize: 5 },
      { priority: 'P0', sortBy: 'title' as const, sortOrder: 'asc' as const },
      { groupBy: 'handler' as const, page: 4, pageSize: 7 },
      { groupBy: 'status' as const, page: 99, pageSize: 25 },
      { iterationId: 'iteration-1', mineOnly: true },
      { risk: 'missing-progress' as const },
      { search: '完全不存在' },
    ]) {
      const remote = await service.requirementsPage(identity, filter, false);
      const local = selectRequirementList(snapshot, filter);
      expect({ ...local, items: local.items.map(({ contentOmitted: _omitted, introductionPreview: _preview, ...item }) => item), groups: local.groups?.map((group) => ({ ...group, items: group.items.map(({ contentOmitted: _omitted, introductionPreview: _preview, ...item }) => item) })) }).toEqual({ ...remote, groups: remote.groups });
    }
  });

  it('reuses bounded expired browser data while deduplicating background refreshes', async () => {
    const { service, listRecords } = createService([requirementRecord('old', '原需求')]);
    await service.browserWorkspace(identity, false);
    const realNow = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
    let complete!: (value: BaseRecord[]) => void;
    const pending = new Promise<BaseRecord[]>((resolve) => { complete = resolve; });
    listRecords.mockImplementation(async (table) => table === 'requirements' ? pending : [iterationRecord()]);
    try {
      const first = await service.browserWorkspace(identity, false);
      const second = await service.browserWorkspace(identity, false);
      expect(first.requirements[0].id).toBe('old');
      expect(first.freshness?.stale).toBe(true);
      expect(second.freshness?.stale).toBe(true);
      expect(listRecords.mock.calls.filter(([table]) => table === 'requirements')).toHaveLength(2);
      complete([requirementRecord('new', '新需求')]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const fresh = await service.browserWorkspace(identity, false);
      expect(fresh.requirements[0].id).toBe('new');
      expect(fresh.freshness?.stale).toBe(false);
    } finally { complete([]); clock.mockRestore(); }
  });

  it('never lets a background list replace a later confirmed row update', async () => {
    const records = [requirementRecord('1', '旧标题')];
    const { service, listRecords, getRecord } = createService(records);
    await service.browserWorkspace(identity, false);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    let complete!: (value: BaseRecord[]) => void;
    const pending = new Promise<BaseRecord[]>((resolve) => { complete = resolve; });
    listRecords.mockImplementation(async (table) => table === 'requirements' ? pending : [iterationRecord()]);
    try {
      await service.browserWorkspace(identity, false);
      service.invalidateRequirement('1');
      getRecord.mockResolvedValue(requirementRecord('1', '已确认的新标题'));
      const reading = service.browserWorkspace(identity, false);
      complete([requirementRecord('1', '旧标题')]);
      expect((await reading).requirements[0].title).toBe('已确认的新标题');
    } finally { complete([]); clock.mockRestore(); }
  });

  it('does not cache actor-specific capabilities across users', async () => {
    const { service, feishu } = createService([requirementRecord('1', '需求')]);
    const first = await service.browserWorkspace(identity, false);
    feishu.getOpenIdByEmployeeId.mockResolvedValue('ou_another');
    const second = await service.browserWorkspace({ userId: 'miaoda-2', userName: '另一位用户' }, false);
    expect(first.requirements[0].isMine).toBe(true);
    expect(second.requirements[0].isMine).toBe(false);
    expect(second.currentUser.miaodaUserId).toBe('miaoda-2');
  });

  it('does not revive an invalidated cache when an older refresh finishes', async () => {
    const { service, listRecords } = createService([requirementRecord('1', '初始')]);
    await service.browserWorkspace(identity, false);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    let complete!: (value: BaseRecord[]) => void;
    const pending = new Promise<BaseRecord[]>((resolve) => { complete = resolve; });
    listRecords.mockImplementation(async (table) => table === 'requirements' ? pending : [iterationRecord()]);
    try {
      await service.browserWorkspace(identity, false);
      service.invalidate();
      complete([requirementRecord('1', '已失效旧快照')]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      listRecords.mockImplementation(async (table) => table === 'requirements' ? [requirementRecord('1', '权威新快照')] : [iterationRecord()]);
      expect((await service.browserWorkspace(identity, false)).requirements[0].title).toBe('权威新快照');
    } finally { complete([]); clock.mockRestore(); }
  });

  it('waits for authoritative data when cached data exceeds the stale window', async () => {
    const { service, listRecords } = createService([requirementRecord('1', '原快照')]);
    await service.browserWorkspace(identity, false);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 151_000);
    let complete!: (value: BaseRecord[]) => void;
    const pending = new Promise<BaseRecord[]>((resolve) => { complete = resolve; });
    listRecords.mockImplementation(async (table) => table === 'requirements' ? pending : [iterationRecord()]);
    try {
      let settled = false;
      const reading = service.browserWorkspace(identity, false).then((value) => { settled = true; return value; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      complete([requirementRecord('1', '新快照')]);
      expect((await reading).requirements[0].title).toBe('新快照');
    } finally { complete([]); clock.mockRestore(); }
  });

  it('keeps reconciled writes when an earlier explicit refresh completes late', async () => {
    const { service, listRecords, getRecord } = createService([requirementRecord('1', '旧标题')]);
    await service.browserWorkspace(identity, false);
    let complete!: (value: BaseRecord[]) => void;
    const pending = new Promise<BaseRecord[]>((resolve) => { complete = resolve; });
    listRecords.mockImplementation(async (table) => table === 'requirements' ? pending : [iterationRecord()]);
    const refresh = service.browserWorkspace(identity, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    service.invalidateRequirement('1');
    getRecord.mockResolvedValue(requirementRecord('1', '确认修改'));
    expect((await service.browserWorkspace(identity, false)).requirements[0].title).toBe('确认修改');
    complete([requirementRecord('1', '旧标题')]);
    expect((await refresh).requirements[0].title).toBe('确认修改');
    expect((await service.browserWorkspace(identity, false)).requirements[0].title).toBe('确认修改');
  });

  it('keeps freshness attached to the returned snapshot when background refresh finishes during aggregation', async () => {
    const { service, listRecords, db } = createService([requirementRecord('old', '旧快照')]);
    await service.browserWorkspace(identity, false);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    let completeRecords!: (value: BaseRecord[]) => void;
    let completeArchive!: (value: unknown[]) => void;
    const records = new Promise<BaseRecord[]>((resolve) => { completeRecords = resolve; });
    const archive = new Promise<unknown[]>((resolve) => { completeArchive = resolve; });
    listRecords.mockImplementation(async (table) => table === 'requirements' ? records : [iterationRecord()]);
    db.execute.mockReturnValue(archive);
    try {
      const reading = service.browserWorkspace(identity, false);
      await new Promise<void>((resolve) => setImmediate(resolve));
      completeRecords([requirementRecord('new', '后台更新快照')]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      completeArchive([]);
      const oldSnapshot = await reading;
      expect(oldSnapshot.requirements[0].id).toBe('old');
      expect(oldSnapshot.freshness?.stale).toBe(true);
    } finally { completeRecords([]); completeArchive([]); clock.mockRestore(); }
  });

});
