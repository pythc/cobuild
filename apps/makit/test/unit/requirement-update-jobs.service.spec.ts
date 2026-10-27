import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { RequirementUpdateJobsService } from '../../server/modules/requirements/requirement-update-jobs.service';
import type { RequirementsCommandService } from '../../server/modules/requirements/requirements-command.service';
import type { RequirementsQueryService } from '../../server/modules/requirements/requirements-query.service';
import type { RequirementPlatformRoleService } from '../../server/modules/requirements/requirement-platform-role.service';
import type { FeishuService } from '../../server/modules/requirements/feishu.service';
import type { ServiceRoleDatabaseExecutor } from '../../server/database/service-role-database.executor';

function sqlDb(rows: unknown[] = []) {
  return {
    execute: jest.fn().mockResolvedValue(rows),
  };
}

function serviceRoleDatabase(
  database: ReturnType<typeof sqlDb>,
): ServiceRoleDatabaseExecutor {
  return {
    run: <T>(operation: (db: PostgresJsDatabase) => Promise<T>): Promise<T> =>
      operation(database as unknown as PostgresJsDatabase),
  } as ServiceRoleDatabaseExecutor;
}

function jobPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'job-1',
    requirement_id: 'rec_test',
    expected_updated_at: null,
    input_json: JSON.stringify({ input: { patch: { priority: 'P1' } } }),
    actor_user_id: 'miaoda-user',
    actor_user_name: '测试用户',
    status: 'queued',
    attempts: 0,
    available_at: '2026-08-12T01:00:00.000Z',
    lock_token: null,
    lock_expires_at: null,
    started_at: null,
    finished_at: null,
    result_json: null,
    error_message: null,
    _created_at: '2026-08-12T01:00:00.000Z',
    _updated_at: '2026-08-12T01:00:00.000Z',
    ...overrides,
  };
}

describe('RequirementUpdateJobsService', () => {
  it.each([false, true])('correction is admitted only with an own, same-requirement, failed parent (%s)', async (allowed) => {
    const db = sqlDb([{job:jobPayload()}]);
    db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce(allowed ? [{id:'11111111-1111-4111-8111-111111111111'}] : []);
    const preflightRequirementUpdateAs = jest.fn().mockResolvedValue({});
    const service = new RequirementUpdateJobsService(db as never, {} as never,
      {preflightRequirementUpdateAs} as never, {} as never, {} as never, {} as never, serviceRoleDatabase(db));
    (service as unknown as {dispatchJob:(id:string)=>void}).dispatchJob = jest.fn();
    const pending = service.enqueueAs('rec_test', {patch:{priority:'P1'},recoveryOf:'11111111-1111-4111-8111-111111111111'},
      {miaodaUserId:'miaoda-user',name:'测试'} as never);
    if (allowed) await expect(pending).resolves.toMatchObject({jobId:'job-1'});
    else { await expect(pending).rejects.toThrow('仅可修正本人'); expect(preflightRequirementUpdateAs).not.toHaveBeenCalled(); }
    const parentQuery = JSON.stringify(db.execute.mock.calls[1]);
    for (const constraint of ['actor_user_id','miaoda-user','requirement_id','rec_test',"status='failed'"]) expect(parentQuery).toContain(constraint);
    expect(db.execute).toHaveBeenCalledTimes(allowed ? 3 : 2);
  });
  it('preflights the request and does not persist Feishu identity data', async () => {
    const db = sqlDb([{ job: jobPayload() }]);
    db.execute.mockResolvedValueOnce([]);
    const currentUser = {
      miaodaUserId: 'miaoda-user',
      employeeId: 'employee-user',
      openId: 'ou_user',
      name: '测试用户',
      platformAppId: 'test-app',
      roles: ['editor'],
      platformRoleIds: ['editor'],
      accessLevel: 'editor' as const,
    };
    const query = { currentUser: jest.fn().mockResolvedValue(currentUser) };
    const preflightRequirementUpdateAs = jest.fn().mockResolvedValue({
      success: true,
      recordId: 'rec_test',
      message: '校验通过',
      updatedFields: ['优先级'],
    });
    const service = new RequirementUpdateJobsService(
      db as unknown as PostgresJsDatabase,
      query as unknown as RequirementsQueryService,
      { preflightRequirementUpdateAs } as unknown as RequirementsCommandService,
      {} as RequirementPlatformRoleService,
      { decorate: jest.fn((user) => user) } as never,
      {} as FeishuService,
      serviceRoleDatabase(db),
    );
    const processJob = jest.fn().mockResolvedValue(undefined);
    (
      service as unknown as { processJob: (id: string) => Promise<void> }
    ).processJob = processJob;

    const result = await service.enqueue(
      'rec_test',
      { expectedUpdatedAt: 123, patch: { priority: 'P1' } },
      {
        userId: 'miaoda-user',
        userName: '测试用户',
        roles: ['editor'],
        appId: 'test-app',
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        jobId: 'job-1',
        jobStatus: 'queued',
      }),
    );
    expect(query.currentUser).toHaveBeenCalledTimes(1);
    expect(preflightRequirementUpdateAs).toHaveBeenCalledWith(
      'rec_test',
      { expectedUpdatedAt: 123, patch: { priority: 'P1' } },
      currentUser,
    );
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(db.execute.mock.calls[1])).not.toContain(
      'employee-user',
    );
    expect(JSON.stringify(db.execute.mock.calls[1])).not.toContain('ou_user');
    expect(JSON.stringify(db.execute.mock.calls[1])).toContain(
      '测试用户',
    );
    expect(JSON.stringify(db.execute.mock.calls[1])).toContain('requirement_update_job_enqueue_v2');
    expect(processJob).toHaveBeenCalledWith('job-1');
  });

  it('parses a string JSON job payload returned by the status RPC', async () => {
    const db = sqlDb([
      {
        job: JSON.stringify(
          jobPayload({
            status: 'succeeded',
            attempts: 1,
            finished_at: '2026-08-12T01:02:00.000Z',
            result_json: JSON.stringify({ success: true, message: '已修改' }),
          }),
        ),
      },
    ]);
    const service = new RequirementUpdateJobsService(
      db as unknown as PostgresJsDatabase,
      {} as RequirementsQueryService,
      {} as RequirementsCommandService,
      {} as RequirementPlatformRoleService,
      {} as never,
      {} as FeishuService,
      serviceRoleDatabase(db),
    );

    await expect(
      service.get('job-1', { userId: 'miaoda-user', userName: '测试用户' }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'job-1',
        requirementId: 'rec_test',
        status: 'succeeded',
        attempts: 1,
        result: { success: true, message: '已修改' },
        createdAt: '2026-08-12T01:00:00.000Z',
        finishedAt: '2026-08-12T01:02:00.000Z',
      }),
    );
  });

  it('keeps a null status payload as not found', async () => {
    const db = sqlDb([{ job: null }]);
    const service = new RequirementUpdateJobsService(
      db as unknown as PostgresJsDatabase,
      {} as RequirementsQueryService,
      {} as RequirementsCommandService,
      {} as RequirementPlatformRoleService,
      {} as never,
      {} as FeishuService,
      serviceRoleDatabase(db),
    );

    await expect(
      service.get('missing-job', {
        userId: 'miaoda-user',
        userName: '测试用户',
      }),
    ).rejects.toThrow('未找到该更新任务');
  });

  it('rejects a malformed status payload instead of treating it as absent', async () => {
    const db = sqlDb([
        { job: jobPayload({ _created_at: 'not-a-timestamp' }) },
      ]);
    const service = new RequirementUpdateJobsService(
      db as unknown as PostgresJsDatabase,
      {} as RequirementsQueryService,
      {} as RequirementsCommandService,
      {} as RequirementPlatformRoleService,
      {} as never,
      {} as FeishuService,
      serviceRoleDatabase(db),
    );

    await expect(
      service.get('job-1', { userId: 'miaoda-user', userName: '测试用户' }),
    ).rejects.toThrow('需求更新任务读取结果无效');
  });

  it('treats a null claim payload as an already claimed job', async () => {
    const db = sqlDb([{ job: null }]);
    const updateRequirementAs = jest.fn();
    const service = new RequirementUpdateJobsService(
      db as unknown as PostgresJsDatabase,
      {} as RequirementsQueryService,
      { updateRequirementAs } as unknown as RequirementsCommandService,
      {} as RequirementPlatformRoleService,
      {} as never,
      {} as FeishuService,
      serviceRoleDatabase(db),
    );

    await (
      service as unknown as { processJob: (id: string) => Promise<void> }
    ).processJob('job-1');

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(updateRequirementAs).not.toHaveBeenCalled();
  });

  it('recovers a queued job without HTTP auth context and rechecks archive state before writing', async () => {
    const db = sqlDb();
    db.execute
      .mockResolvedValueOnce([
        {
          job: jobPayload({
            status: 'running',
            attempts: 1,
            lock_token: 'worker-token',
            lock_expires_at: '2026-08-12T01:15:00.000Z',
          }),
        },
      ])
      .mockResolvedValueOnce([{ renewed: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ renewed: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ updated: true }]);
    const updateRequirementAsWorker = jest.fn(
      async (
        _recordId: string,
        _input: unknown,
        _actor: unknown,
        _archivedIds: ReadonlySet<string>,
        beforePersist: () => Promise<void>,
      ) => {
        await beforePersist();
        return {
          success: true,
          message: '已修改',
          recordId: 'rec_test',
          updatedFields: ['优先级'],
        };
      },
    );
    const service = new RequirementUpdateJobsService(
      db as unknown as PostgresJsDatabase,
      {} as RequirementsQueryService,
      { updateRequirementAsWorker } as unknown as RequirementsCommandService,
      {
        employeeId: jest.fn().mockResolvedValue('employee-user'),
        currentRoles: jest.fn().mockResolvedValue(['editor']),
      } as unknown as RequirementPlatformRoleService,
      {
        decorate: jest.fn((user) => ({
          ...user,
          roles: ['editor'],
          accessLevel: 'editor',
        })),
      } as never,
      {
        getUserByEmployeeId: jest.fn().mockResolvedValue({
          employeeId: 'employee-user',
          openId: 'ou_user',
          name: '实时飞书姓名',
        }),
      } as unknown as FeishuService,
      serviceRoleDatabase(db),
    );

    await (
      service as unknown as { processJob: (id: string) => Promise<void> }
    ).processJob('job-1');

    expect(updateRequirementAsWorker).toHaveBeenCalledWith(
      'rec_test',
      { patch: { priority: 'P1' } },
      expect.objectContaining({
        employeeId: 'employee-user',
        openId: 'ou_user',
        accessLevel: 'editor',
      }),
      expect.any(Set),
      expect.any(Function),
      'job-1',
      expect.objectContaining({ beforeWrite: expect.any(Function), confirmed: expect.any(Function) }),
    );
    expect(db.execute).toHaveBeenCalledTimes(6);
  });

  it('preflights a release transition before creating a job', async () => {
    const db = sqlDb();
    const currentUser = {
      miaodaUserId: 'miaoda-user',
      employeeId: 'employee-user',
      openId: 'ou_user',
      name: '测试用户',
      roles: ['editor'],
    };
    const query = {
      currentUser: jest.fn().mockResolvedValue(currentUser),
    };
    const preflightRequirementUpdateAs = jest
      .fn()
      .mockRejectedValue(new Error('发布就绪检查未通过：验收项全部完成'));
    const service = new RequirementUpdateJobsService(
      db as unknown as PostgresJsDatabase,
      query as unknown as RequirementsQueryService,
      { preflightRequirementUpdateAs } as unknown as RequirementsCommandService,
      {} as RequirementPlatformRoleService,
      { decorate: jest.fn((user) => user) } as never,
      {} as FeishuService,
      serviceRoleDatabase(db),
    );

    await expect(
      service.enqueue(
        'rec_release',
        {
          expectedUpdatedAt: 123,
          patch: { status: '待发布' },
        },
        { userId: 'miaoda-user', userName: '测试用户', roles: ['editor'] },
      ),
    ).rejects.toThrow('发布就绪检查未通过');

    expect(preflightRequirementUpdateAs).toHaveBeenCalled();
    // The idempotency lookup is read-only; a rejected gate must not enqueue.
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.execute.mock.calls)).not.toContain('requirement_update_job_enqueue_v2');
  });

  it('rechecks live roles and resolves the actor name from Feishu', async () => {
    const currentRoles = jest.fn().mockResolvedValue(['viewer']);
    const employeeId = jest.fn().mockResolvedValue('employee-user');
    const db = sqlDb();
    const service = new RequirementUpdateJobsService(
      db as unknown as PostgresJsDatabase,
      {} as RequirementsQueryService,
      {} as RequirementsCommandService,
      { currentRoles, employeeId } as unknown as RequirementPlatformRoleService,
      {
        decorate: jest.fn((user) => ({
          ...user,
          roles: ['viewer'],
          accessLevel: 'viewer',
        })),
      } as never,
      {
        getUserByEmployeeId: jest.fn().mockResolvedValue({
          employeeId: 'employee-user',
          openId: 'ou_user',
          name: '实时飞书姓名',
        }),
      } as unknown as FeishuService,
      serviceRoleDatabase(db),
    );
    const rebuilt = await (
      service as unknown as {
        rebuildCurrentUser: (
          envelope: unknown,
          job: unknown,
        ) => Promise<Record<string, unknown>>;
      }
    ).rebuildCurrentUser(
      {
        input: { patch: { priority: 'P1' } },
      },
      { actorUserId: 'miaoda-user', actorUserName: '测试用户' },
    );

    expect(currentRoles).toHaveBeenCalledWith('miaoda-user', '');
    expect(employeeId).toHaveBeenCalledWith('miaoda-user');
    expect(rebuilt).toEqual(
      expect.objectContaining({
        platformRoleIds: ['viewer'],
      }),
    );
    expect(rebuilt).toEqual(
      expect.objectContaining({
        roles: ['viewer'],
        accessLevel: 'viewer',
        name: '实时飞书姓名',
      }),
    );
  });

  it('rejects a worker identity when the live Feishu profile is incomplete', async () => {
    const db = sqlDb();
    const service = new RequirementUpdateJobsService(
      db as unknown as PostgresJsDatabase,
      {} as RequirementsQueryService,
      {} as RequirementsCommandService,
      {
        employeeId: jest.fn().mockResolvedValue('employee-user'),
      } as unknown as RequirementPlatformRoleService,
      {} as never,
      {
        getUserByEmployeeId: jest.fn().mockResolvedValue({
          employeeId: 'employee-user',
          openId: '',
          name: '用户',
        }),
      } as unknown as FeishuService,
      serviceRoleDatabase(db),
    );

    await expect(
      (
        service as unknown as {
          rebuildCurrentUser: (
            envelope: unknown,
            job: unknown,
          ) => Promise<Record<string, unknown>>;
        }
      ).rebuildCurrentUser(
        { input: { patch: { priority: 'P1' } } },
        { actorUserId: 'miaoda-user', actorUserName: '伪造姓名' },
      ),
    ).rejects.toThrow('无法重新确认更新任务飞书身份');
  });
});
