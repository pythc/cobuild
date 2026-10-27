import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import type { CurrentUserSummary } from '@shared/api.interface';
import type {
  BaseRecord,
  FeishuService,
} from '../../server/modules/requirements/feishu.service';
import { RequirementAccessService } from '../../server/modules/requirements/requirement-access.service';
import { RequirementArchiveService } from '../../server/modules/requirements/requirement-archive.service';
import type { RequirementsQueryService } from '../../server/modules/requirements/requirements-query.service';

const TABLES: Readonly<Record<string, string>> = {
  FEISHU_REQUIREMENTS_TABLE: 'requirements',
  FEISHU_COMMENTS_TABLE: 'comments',
  FEISHU_ACCEPTANCE_TABLE: 'acceptance',
  FEISHU_RELATIONS_TABLE: 'relations',
  FEISHU_COLLABORATION_TABLE: 'collaboration',
};

const ACTOR: CurrentUserSummary = {
  miaodaUserId: 'miaoda-admin',
  employeeId: 'employee-admin',
  openId: 'ou_admin',
  name: '管理员',
  roles: ['admin'],
};

const ARCHIVE_ROW = {
  requirement_id: 'requirement-1',
  requirement_code: 'REQ-1',
  requirement_title: '待删除需求',
  archived_at: '2026-08-12T08:00:00.000Z',
  archived_by_name: '管理员',
  deletion_status: 'idle',
  deletion_error: null,
};

interface ServiceFixture {
  service: RequirementArchiveService;
  execute: jest.Mock;
  searchRecords: jest.Mock;
  listRecords: jest.Mock;
  getRecord: jest.Mock;
  deleteRecord: jest.Mock;
  invalidate: jest.Mock;
  invalidateDetailSupport: jest.Mock;
  requirementByIdAs: jest.Mock;
  assertWorkflowVersion: jest.Mock;
}

function fixture(databaseResponses: unknown[][]): ServiceFixture {
  const queuedResponses: unknown[][] = [...databaseResponses];
  const execute = jest.fn().mockImplementation(async (): Promise<unknown[]> => {
    const next: unknown[] | undefined = queuedResponses.shift();
    return next || [];
  });
  const listRecords = jest.fn().mockResolvedValue([]);
  const searchRecords = jest.fn().mockResolvedValue([]);
  const getRecord = jest.fn();
  const deleteRecord = jest.fn().mockResolvedValue(undefined);
  const invalidate = jest.fn();
  const invalidateDetailSupport = jest.fn();
  const requirementByIdAs = jest.fn().mockResolvedValue({
    id: ARCHIVE_ROW.requirement_id,
    iterationIds: ['test-iteration'],
    status: '开发中',
  });
  const assertWorkflowVersion = jest.fn().mockResolvedValue(undefined);
  const query = {
    table: jest.fn((name: string): string => TABLES[name]),
    invalidate,
    invalidateDetailSupport,
    requirementByIdAs,
    assertWorkflowVersion,
  };
  const feishu = { searchRecords, listRecords, getRecord, deleteRecord };
  const service = new RequirementArchiveService(
    { execute } as unknown as PostgresJsDatabase,
    feishu as unknown as FeishuService,
    query as unknown as RequirementsQueryService,
    new RequirementAccessService(),
  );
  return {
    service,
    execute,
    searchRecords,
    listRecords,
    getRecord,
    deleteRecord,
    invalidate,
    invalidateDetailSupport,
    requirementByIdAs,
    assertWorkflowVersion,
  };
}

function queryChunks(call: unknown[]): unknown[] {
  return (call[0] as { queryChunks: unknown[] }).queryChunks;
}

describe('RequirementArchiveService deletion saga', () => {
  afterEach((): void => {
    jest.restoreAllMocks();
  });
  it('restores only a source record that is compatible with current iteration rules', async () => {
    const { service, execute, requirementByIdAs, assertWorkflowVersion } =
      fixture([[ARCHIVE_ROW], [{ affected_count: 1 }]]);
    await expect(
      service.restore(ARCHIVE_ROW.requirement_id, ACTOR),
    ).resolves.toMatchObject({ success: true });
    expect(requirementByIdAs).toHaveBeenCalledWith(
      ARCHIVE_ROW.requirement_id,
      ACTOR,
      new Set(),
    );
    expect(assertWorkflowVersion).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each([
    { iterationIds: ['a', 'b'], status: '开发中' },
    {
      iterationIds: ['a'],
      status: '开发中',
      workflow: { statuses: ['新', '已发布'] },
    },
  ])('does not revive incompatible archived data: %j', async (requirement) => {
    const { service, execute, requirementByIdAs } = fixture([[ARCHIVE_ROW]]);
    requirementByIdAs.mockResolvedValue(requirement);
    await expect(
      service.restore(ARCHIVE_ROW.requirement_id, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('keeps an archived requirement archived if configuration changes during restore', async () => {
    const { service, execute, assertWorkflowVersion } = fixture([
      [ARCHIVE_ROW],
    ]);
    assertWorkflowVersion.mockRejectedValue(
      new ConflictException('规则已更新'),
    );
    await expect(
      service.restore(ARCHIVE_ROW.requirement_id, ACTOR),
    ).rejects.toThrow('规则已更新');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('completes a retry when the authoritative requirement record is already absent', async () => {
    const {
      service,
      execute,
      searchRecords,
      listRecords,
      deleteRecord,
      invalidate,
    } = fixture([
      [{ ...ARCHIVE_ROW, deletion_status: 'failed' }],
      [{ claim_token: '00000000-0000-4000-8000-000000000001' }],
      [{ affected_count: 1 }],
    ]);

    await expect(
      service.permanentlyDelete(ARCHIVE_ROW.requirement_id, ACTOR),
    ).resolves.toMatchObject({
      success: true,
      recordId: ARCHIVE_ROW.requirement_id,
    });

    expect(searchRecords).toHaveBeenCalledTimes(4);
    expect(listRecords).toHaveBeenCalledTimes(1);
    expect(deleteRecord).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('marks a failed deletion and rethrows the original delete error', async () => {
    const originalError = new Error('base delete failed');
    const { service, execute, searchRecords, deleteRecord } = fixture([
      [ARCHIVE_ROW],
      [{ claim_token: '00000000-0000-4000-8000-000000000002' }],
      [{ affected_count: 1 }],
      [{ affected_count: 1 }],
    ]);
    const relatedRecord: BaseRecord = {
      record_id: 'comment-1',
      fields: { 需求: [{ record_id: ARCHIVE_ROW.requirement_id }] },
    };
    searchRecords.mockImplementation(
      async (tableId: string): Promise<BaseRecord[]> =>
        tableId === TABLES.FEISHU_COMMENTS_TABLE ? [relatedRecord] : [],
    );
    deleteRecord.mockRejectedValueOnce(originalError);

    const deletion = service.permanentlyDelete(
      ARCHIVE_ROW.requirement_id,
      ACTOR,
    );
    await expect(deletion).rejects.toBe(originalError);

    expect(execute).toHaveBeenCalledTimes(4);
    expect(queryChunks(execute.mock.calls[3])).toContain('base delete failed');
  });

  it('does not mask the original delete error when recording failed also fails', async () => {
    const originalError = new Error('base delete failed');
    const markFailedError = new Error('database unavailable');
    jest.spyOn(Logger.prototype, 'error').mockImplementation((): void => {});
    const { service, execute, searchRecords, deleteRecord } = fixture([]);
    execute
      .mockResolvedValueOnce([ARCHIVE_ROW])
      .mockResolvedValueOnce([
        { claim_token: '00000000-0000-4000-8000-000000000003' },
      ])
      .mockResolvedValueOnce([{ affected_count: 1 }])
      .mockRejectedValueOnce(markFailedError);
    searchRecords.mockResolvedValueOnce([
      {
        record_id: 'comment-1',
        fields: { 需求: [{ record_id: ARCHIVE_ROW.requirement_id }] },
      },
    ]);
    deleteRecord.mockRejectedValueOnce(originalError);

    await expect(
      service.permanentlyDelete(ARCHIVE_ROW.requirement_id, ACTOR),
    ).rejects.toBe(originalError);
  });

  it.each(['deleting', 'failed'] as const)(
    'rejects restore while deletion status is %s',
    async (deletionStatus: 'deleting' | 'failed') => {
      const { service, execute, getRecord } = fixture([
        [{ ...ARCHIVE_ROW, deletion_status: deletionStatus }],
      ]);

      await expect(
        service.restore(ARCHIVE_ROW.requirement_id, ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(getRecord).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects archive metadata reads before SQL without login', async () => {
    const { service, execute } = fixture([]);

    await expect(
      service.list({
        ...ACTOR,
        miaodaUserId: '',
        roles: [],
        platformRoleIds: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects permanent deletion before SQL without login', async () => {
    const { service, execute } = fixture([]);

    await expect(
      service.permanentlyDelete(ARCHIVE_ROW.requirement_id, {
        ...ACTOR,
        miaodaUserId: '',
        roles: ['editor'],
        platformRoleIds: ['editor'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a conflict when a background update is still active', async () => {
    const { service, execute } = fixture([]);
    execute
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('requirement has active update jobs'));

    await expect(
      service.archive(
        {
          id: ARCHIVE_ROW.requirement_id,
          code: ARCHIVE_ROW.requirement_code,
          title: ARCHIVE_ROW.requirement_title,
        } as never,
        ACTOR,
      ),
    ).rejects.toThrow('需求仍有更新任务在执行，请稍后再归档');
  });
});
