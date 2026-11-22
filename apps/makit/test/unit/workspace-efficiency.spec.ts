import { validateSavedViewConfig } from '../../shared/workspace-efficiency';
import {
  legacySavedViewConfig,
  savedViewSearch,
} from '../../client/src/lib/saved-view-query';
import {
  materialTemplate,
  isOnlyMaterialTemplate,
} from '../../shared/material-templates';
import { RequirementsQueryService } from '../../server/modules/requirements/requirements-query.service';
import { RequirementAccessService } from '../../server/modules/requirements/requirement-access.service';

describe('saved view contracts', () => {
  it('accepts current filters, grouping and bounded widths', () => {
    expect(
      validateSavedViewConfig({
        query: {
          mineOnly: true,
          groupBy: 'handler',
          sortBy: 'deadlineAt',
          sortOrder: 'asc',
          pageSize: 50,
        },
        viewMode: 'cards',
        columnWidths: { title: 380, risk: 100 },
      }),
    ).toBe(true);
  });
  it('restores participant filters and preserves legacy handler views', () => {
    const participation = { query: { participatingOnly: true } };
    expect(validateSavedViewConfig(participation)).toBe(true);
    expect(savedViewSearch(participation).toString()).toBe('mine=1');
    const legacy = legacySavedViewConfig('mine=1&view=cards');
    expect(legacy?.query).toEqual({ mineOnly: true });
    expect(legacy && savedViewSearch(legacy).toString()).toBe('assigned=1&view=cards');
  });
  it.each([
    { query: { page: 5 } },
    { query: { redirect: 'https://evil.test' } },
    { query: { pageSize: 1000 } },
    { query: { mineOnly: 'yes' } },
    { query: { participatingOnly: 'yes' } },
    { query: { groupBy: 'untrusted' } },
    { query: { sortBy: 'body' } },
    { query: {}, columnWidths: { title: Number.NaN } },
    { query: {}, columnWidths: { title: 10000 } },
    { query: {}, viewMode: 'script' },
    { query: {}, __unknown: 'x' },
  ])('rejects unsupported saved configuration %#', (config) =>
    expect(validateSavedViewConfig(config)).toBe(false),
  );
  it.each(['technical_design', 'self_test_report', 'defect_cause'] as const)(
    'never treats the blank %s template as filled evidence',
    (kind) => {
      expect(isOnlyMaterialTemplate(materialTemplate(kind), kind)).toBe(true);
      expect(isOnlyMaterialTemplate(materialTemplate(kind, false), kind)).toBe(
        true,
      );
      expect(
        isOnlyMaterialTemplate(
          `${materialTemplate(kind)}<p>具体分析与验证证据</p>`,
          kind,
        ),
      ).toBe(false);
    },
  );
});

describe('isolated lightweight requirement reads', () => {
  const tableKeys = [
    'REQUIREMENTS',
    'ITERATIONS',
    'COMMENTS',
    'ACCEPTANCE',
    'RELATIONS',
    'COLLABORATION',
  ];
  const old: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const key of tableKeys) {
      const name = `FEISHU_${key}_TABLE`;
      old[name] = process.env[name];
      process.env[name] = key.toLowerCase();
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const identity = { userId: '185000000000000001', userName: '测试用户' };
  function setup() {
    const record = {
      record_id: 'recTestOne',
      fields: {
        需求: '测试',
        状态: '开发中',
        需求类型: '产品需求',
        需求介绍: '<p>正文</p>',
        当前处理人: [{ id: 'employee1', name: '测试用户' }],
        更新时间: 1700000000000,
      },
    };
    const feishu = {
      getRecord: jest.fn().mockResolvedValue(record),
      searchRecords: jest.fn().mockResolvedValue([]),
      listRecords: jest.fn(async (table: string) =>
        table === 'requirements' ? [record] : [],
      ),
      listFields: jest.fn().mockResolvedValue([]),
      getOpenIdByEmployeeId: jest.fn().mockResolvedValue('employee1'),
    };
    const service = new RequirementsQueryService(
      feishu as never,
      {
        getCurrentUserLarkUserId: jest.fn().mockResolvedValue('employee1'),
      } as never,
      new RequirementAccessService(),
      { execute: jest.fn().mockResolvedValue([]) } as never,
      {
        publishedMap: jest.fn().mockResolvedValue(new Map()),
        decorate: jest.fn(),
      } as never,
    );
    return { service, feishu, record };
  }
  it('shows the core without any comments/history/relations calls', async () => {
    const { service, feishu } = setup();
    const result = await service.detailCore('recTestOne', identity);
    expect(result.requirement.introduction).toBe('<p>正文</p>');
    expect(feishu.getRecord).toHaveBeenCalledTimes(1);
    expect(feishu.searchRecords).not.toHaveBeenCalled();
  });
  it('loads only the selected section', async () => {
    const { service, feishu } = setup();
    const result = await service.detailSection(
      'recTestOne',
      identity,
      'comments',
    );
    expect(result.section).toBe('comments');
    expect(feishu.searchRecords).toHaveBeenCalledTimes(1);
    expect(feishu.searchRecords.mock.calls[0][0]).toBe('comments');
  });
  it('scoped invalidation reloads one requirement without refetching references', async () => {
    const { service, feishu } = setup();
    await service.workspace(identity, false);
    const initialCalls = feishu.listRecords.mock.calls.length;
    service.invalidateRequirement('recTestOne');
    await service.workspace(identity, false);
    expect(feishu.listRecords).toHaveBeenCalledTimes(initialCalls);
    expect(feishu.getRecord).toHaveBeenCalledTimes(1);
    expect(feishu.listFields).toHaveBeenCalledTimes(1);
  });
  it('maps the exact confirmed snapshot without a second remote read', async () => {
    const { service, feishu, record } = setup();
    const actor = await service.currentUser(identity);
    const result = await service.summaryFromRecordAs(record, actor);
    expect(result.title).toBe('测试');
    expect(result.personnelUserIds.handlers).toEqual(['employee1']);
    expect(feishu.getRecord).not.toHaveBeenCalled();
  });
});
