import { ProjectArchivedError } from '../../common/selfhost/project-write-policy';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import { withSelfhostActor } from '../../common/selfhost/context';
import { randomUUID } from 'node:crypto';
import type {
  CurrentUserSummary,
  MutationResult,
  RequirementUpdateInput,
  RequirementUpdateJobAccepted,
  RequirementUpdateJobStatus,
  RequirementUpdateJobSummary,
} from '@shared/api.interface';
import { RequirementsCommandService } from './requirements-command.service';
import { RequirementsQueryService } from './requirements-query.service';
import { RequirementPlatformRoleService } from './requirement-platform-role.service';
import { RequirementAccessService } from './requirement-access.service';
import { FeishuService, FeishuRequestError } from './feishu.service';
import {
  operationRequestHash,
  validateOperationEnvelope,
} from './requirement-operation.model';
import { safeOperationError } from '../operations/operations.model';
import { OperationsTelemetryService } from '../operations/operations-telemetry.service';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';

interface RequestIdentity {
  userId: string;
  userName: string;
  roles?: string[];
  appId?: string;
}

interface UpdateJobEnvelope {
  input: RequirementUpdateInput;
}

interface UpdateJobRecord {
  id: string;
  requirementId: string;
  expectedUpdatedAt: string | null;
  inputJson: string;
  actorUserId: string;
  actorUserName: string;
  status: RequirementUpdateJobStatus;
  attempts: number;
  availableAt: Date;
  lockToken: string | null;
  lockExpiresAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UpdateJobPayloadRow extends Record<string, unknown> {
  job: unknown;
}

interface ArchivedRequirementRow extends Record<string, unknown> {
  requirement_id: string;
}

type UpdateJobPayloadContext = '创建' | '读取' | '领取';

const JOB_LEASE_MS: number = 15 * 60 * 1000;
const JOB_HEARTBEAT_MS: number = 60 * 1000;

@Injectable()
export class RequirementUpdateJobsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger: Logger = new Logger(
    RequirementUpdateJobsService.name,
  );
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly queryService: RequirementsQueryService,
    private readonly commandService: RequirementsCommandService,
    private readonly platformRoles: RequirementPlatformRoleService,
    private readonly access: RequirementAccessService,
    private readonly feishu: FeishuService,
    private readonly serviceRoleDatabase: ServiceRoleDatabaseExecutor,
    @Optional() private readonly telemetry?: OperationsTelemetryService,
  ) {}

  onModuleInit(): void {
    if (process.env.MAKIT_WORKERS_ENABLED === 'false' && process.env.COBUILD_IDENTITY_MODE !== 'local') return;
    setTimeout((): void => {
      this.dispatchPendingJobs();
    }, 0);
    this.recoveryTimer = setInterval((): void => {
      this.dispatchPendingJobs();
    }, 30_000);
    this.recoveryTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  async enqueue(
    requirementId: string,
    input: RequirementUpdateInput,
    identity: RequestIdentity,
  ): Promise<RequirementUpdateJobAccepted> {
    const currentUser: CurrentUserSummary =
      await this.queryService.currentUser(identity);
    return this.enqueueAs(requirementId, input, currentUser);
  }

  /** Server-only MCP identity: hash the caller's stable intent, not a newly read baseline. */
  async replayMcpAs(
    mutationId: string | undefined,
    hash: string,
    currentUser: CurrentUserSummary,
  ): Promise<RequirementUpdateJobAccepted | null> {
    if (!mutationId) return null;
    if (
      !/^[a-zA-Z0-9_-]{8,128}$/u.test(mutationId) ||
      !/^[a-f0-9]{64}$/u.test(hash)
    )
      throw new BadRequestException('操作标识无效');
    const rows = await this.serviceRoleDatabase.run((db) =>
      db.execute<UpdateJobPayloadRow>(sql`SELECT to_jsonb(j) AS job FROM requirement_update_job j
      WHERE actor_user_id=${currentUser.miaodaUserId} AND client_mutation_id=${mutationId}`),
    );
    if (!rows[0]?.job) return null;
    const raw =
      typeof rows[0].job === 'string' ? JSON.parse(rows[0].job) : rows[0].job;
    if (raw.request_hash !== hash || raw.source !== 'mcp')
      throw new ConflictException('同一操作标识对应了不同修改，请重新提交');
    const prior = this.parseJobPayload(raw, '读取');
    if (!prior) throw new Error('操作记录无效');
    return {
      success: prior.status !== 'failed',
      message: prior.status === 'failed' ? '修改失败' : '已修改',
      recordId: raw.requirement_id,
      jobId: prior.id,
      jobStatus: prior.status,
    };
  }

  async enqueueAs(
    requirementId: string,
    input: RequirementUpdateInput,
    currentUser: CurrentUserSummary,
    mcpHash?: string,
  ): Promise<RequirementUpdateJobAccepted> {
    try {
      validateOperationEnvelope(input);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : '修改内容无效',
      );
    }
    const mutationId = input.clientMutationId || randomUUID();
    const normalizedInput = {
      ...input,
      clientMutationId: mutationId,
      source: input.source || ('web' as const),
    };
    if (mcpHash && (input.source !== 'mcp' || !/^[a-f0-9]{64}$/u.test(mcpHash)))
      throw new BadRequestException('操作来源无效');
    const hash =
      mcpHash || operationRequestHash(requirementId, normalizedInput);
    const existing = await this.serviceRoleDatabase.run((db) =>
      db.execute<UpdateJobPayloadRow>(sql`
      SELECT to_jsonb(j) AS job FROM requirement_update_job j
      WHERE actor_user_id=${currentUser.miaodaUserId} AND client_mutation_id=${mutationId}
    `),
    );
    if (existing[0]?.job) {
      const raw =
        typeof existing[0].job === 'string'
          ? JSON.parse(existing[0].job)
          : existing[0].job;
      if (raw.request_hash !== hash || raw.requirement_id !== requirementId)
        throw new ConflictException('同一操作标识对应了不同修改，请重新提交');
      const prior = this.parseJobPayload(raw, '读取');
      if (!prior) throw new Error('操作记录无效');
      return {
        success: prior.status !== 'failed',
        message: '已修改',
        recordId: requirementId,
        jobId: prior.id,
        jobStatus: prior.status,
      };
    }
    // Validate authorization, optimistic-lock, options and required transition
    // fields before admission. The durable worker repeats these checks and
    // performs authoritative release checks (including slow GitHub refresh)
    // before the remote write; an unauthorized request must never be queued.
    if (input.recoveryOf) {
      const parents = await this.serviceRoleDatabase.run((db) => db.execute<{ id: string }>(sql`
        SELECT id FROM requirement_update_job WHERE id=${input.recoveryOf}::uuid
          AND actor_user_id=${currentUser.miaodaUserId} AND requirement_id=${requirementId} AND status='failed'`));
      if (!parents.length) throw new BadRequestException('仅可修正本人在此需求上已确认失败的操作');
    }
    await this.commandService.preflightRequirementUpdateAs(
      requirementId,
      input,
      currentUser,
    );
    let rows: UpdateJobPayloadRow[];
    try {
      rows = await this.serviceRoleDatabase.run((db) =>
        db.execute<UpdateJobPayloadRow>(sql`
        SELECT requirement_update_job_enqueue_v2(
          ${requirementId}::varchar,
          ${JSON.stringify(normalizedInput)}::jsonb,
          ${currentUser.miaodaUserId}::varchar,
          ${currentUser.name}::varchar,
          ${mutationId}::varchar,
          ${hash}::varchar,
          ${normalizedInput.source}::varchar
        ) AS "job"
      `),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('requirement is archived')
      ) {
        throw new ConflictException('该需求已归档，请先恢复后再操作');
      }
      throw error;
    }
    const job: UpdateJobRecord | null = this.parseJobPayload(
      rows[0]?.job,
      '创建',
    );
    if (!job) throw new Error('需求更新任务创建失败');
    this.dispatchJob(job.id);
    return {
      success: true,
      message: '已修改',
      recordId: requirementId,
      jobId: job.id,
      jobStatus: job.status,
    };
  }

  async get(
    jobId: string,
    _identity: RequestIdentity,
  ): Promise<RequirementUpdateJobSummary> {
    const rows: UpdateJobPayloadRow[] = await this.db
      .execute<UpdateJobPayloadRow>(sql`
      SELECT requirement_update_job_get(${jobId}::uuid) AS "job"
    `);
    const job: UpdateJobRecord | null = this.parseJobPayload(
      rows[0]?.job,
      '读取',
    );
    if (!job) throw new NotFoundException('未找到该更新任务');
    return this.summary(job);
  }

  private summary(job: UpdateJobRecord): RequirementUpdateJobSummary {
    let result: MutationResult | null = null;
    if (job.resultJson) {
      try {
        result = JSON.parse(job.resultJson) as MutationResult;
      } catch {
        result = null;
      }
    }
    return {
      id: job.id,
      requirementId: job.requirementId,
      status: job.status as RequirementUpdateJobStatus,
      attempts: job.attempts,
      result,
      errorMessage: job.errorMessage || '',
      createdAt: job.createdAt?.toISOString() || null,
      finishedAt: job.finishedAt?.toISOString() || null,
    };
  }

  private parseJobPayload(
    payload: unknown,
    context: UpdateJobPayloadContext,
  ): UpdateJobRecord | null {
    if (payload == null) return null;
    let decoded: unknown = payload;
    if (typeof decoded === 'string') {
      try {
        decoded = JSON.parse(decoded) as unknown;
      } catch {
        throw new Error(`需求更新任务${context}结果无效`);
      }
    }
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      Array.isArray(decoded)
    ) {
      throw new Error(`需求更新任务${context}结果无效`);
    }
    const value = decoded as Record<string, unknown>;
    const invalid = (): never => {
      throw new Error(`需求更新任务${context}结果无效`);
    };
    const requiredString = (key: string): string => {
      const field = value[key];
      if (typeof field !== 'string' || field.length === 0) return invalid();
      return field;
    };
    const nullableString = (key: string): string | null => {
      const field = value[key];
      if (field == null) return null;
      if (typeof field !== 'string') return invalid();
      return field;
    };
    const date = (key: string, nullable: boolean): Date | null => {
      const field = value[key];
      if (field == null) {
        if (nullable) return null;
        return invalid();
      }
      if (
        typeof field !== 'string' &&
        typeof field !== 'number' &&
        !(field instanceof Date)
      ) {
        return invalid();
      }
      const parsed = new Date(field instanceof Date ? field.getTime() : field);
      if (Number.isNaN(parsed.getTime())) return invalid();
      return parsed;
    };
    const status = requiredString('status');
    if (
      !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(status)
    ) {
      return invalid();
    }
    const attempts = value.attempts;
    if (
      typeof attempts !== 'number' ||
      !Number.isInteger(attempts) ||
      attempts < 0
    ) {
      return invalid();
    }
    const actorUserName = value.actor_user_name;
    if (typeof actorUserName !== 'string') return invalid();
    return {
      id: requiredString('id'),
      requirementId: requiredString('requirement_id'),
      expectedUpdatedAt: nullableString('expected_updated_at'),
      inputJson: requiredString('input_json'),
      actorUserId: requiredString('actor_user_id'),
      actorUserName,
      status: status as RequirementUpdateJobStatus,
      attempts,
      availableAt: date('available_at', false) as Date,
      lockToken: nullableString('lock_token'),
      lockExpiresAt: date('lock_expires_at', true),
      startedAt: date('started_at', true),
      finishedAt: date('finished_at', true),
      resultJson: nullableString('result_json'),
      errorMessage: nullableString('error_message'),
      createdAt: date('_created_at', false) as Date,
      updatedAt: date('_updated_at', false) as Date,
    };
  }

  private async processPendingJobs(): Promise<void> {
    const jobs: Array<{ id: string }> = await this.serviceRoleDatabase.run(
      (database: PostgresJsDatabase) =>
        database.execute<{ id: string }>(
          sql`SELECT id FROM requirement_update_job_pending_ids_v2(20::integer)`,
        ),
    );
    await Promise.all(
      jobs.map(async (job): Promise<void> => {
        await this.processJob(job.id);
      }),
    );
  }

  private dispatchPendingJobs(): void {
    if (process.env.MAKIT_WORKERS_ENABLED === 'false' && process.env.COBUILD_IDENTITY_MODE !== 'local') return;
    const work = () => this.processPendingJobs();
    void (
      this.telemetry ? this.telemetry.scanner('requirement_jobs', work) : work()
    ).catch((error: unknown): void => {
      this.logger.error(
        `扫描需求更新任务失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private dispatchJob(jobId: string): void {
    void this.processJob(jobId).catch((error: unknown): void => {
      this.logger.error(
        `启动需求更新任务 ${jobId} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async processJob(jobId: string): Promise<void> {
    if (process.env.MAKIT_WORKERS_ENABLED === 'false' && process.env.COBUILD_IDENTITY_MODE !== 'local') return;
    const work = () => this.executeJob(jobId);
    return this.telemetry ? this.telemetry.operation(jobId, work) : work();
  }

  private async executeJob(jobId: string): Promise<void> {
    const lockToken: string = randomUUID();
    const rows: UpdateJobPayloadRow[] = await this.serviceRoleDatabase.run(
      (database: PostgresJsDatabase) =>
        database.execute<UpdateJobPayloadRow>(sql`
          SELECT requirement_update_job_claim_v2(
            ${jobId}::uuid,
            ${lockToken}::varchar
          ) AS "job"
        `),
    );
    const job: UpdateJobRecord | null = this.parseJobPayload(
      rows[0]?.job,
      '领取',
    );
    if (!job) return;

    let leaseLost: boolean = false;
    let externalWriteStarted = false;
    let externalWriteConfirmed = false;
    let heartbeatRunning: boolean = false;
    const heartbeat = async (): Promise<void> => {
      if (heartbeatRunning || leaseLost) return;
      heartbeatRunning = true;
      try {
        const renewed: boolean = await this.renewLease(job.id, lockToken);
        if (!renewed) {
          leaseLost = true;
          this.logger.error(`需求更新任务 ${job.id} 租约已失效`);
        }
      } catch (error) {
        // A transient database failure is not proof that ownership was lost.
        // The mandatory fence immediately before the external write decides.
        this.logger.warn(
          `需求更新任务 ${job.id} 心跳失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        heartbeatRunning = false;
      }
    };
    const heartbeatTimer = setInterval((): void => {
      void heartbeat();
    }, JOB_HEARTBEAT_MS);
    heartbeatTimer.unref();

    try {
      const envelope: UpdateJobEnvelope = JSON.parse(
        job.inputJson,
      ) as UpdateJobEnvelope;
      const currentUser: CurrentUserSummary = await this.rebuildCurrentUser(
        envelope,
        job,
      );
      // Fence the irreversible Feishu write immediately before it starts. If
      // another Pod reclaimed this job, the old worker stops without emitting
      // duplicate Base updates or workflow notifications.
      if (leaseLost || !(await this.renewLease(job.id, lockToken))) {
        throw new Error('更新任务租约已失效，已停止执行');
      }
      const archivedIds: Set<string> = await this.workerArchivedIds();
      const result: MutationResult =
        await withSelfhostActor(currentUser, () => this.commandService.updateRequirementAsWorker(
          job.requirementId,
          envelope.input,
          currentUser,
          archivedIds,
          async (): Promise<void> => {
            if (!(await this.renewLease(job.id, lockToken))) {
              leaseLost = true;
              throw new Error('更新任务租约已失效，已停止执行');
            }
            const latestArchivedIds: Set<string> =
              await this.workerArchivedIds();
            if (latestArchivedIds.has(job.requirementId)) {
              throw new Error('该需求已归档，请先恢复后再操作');
            }
          },
          job.id,
          {
            beforeWrite: async (before, fields) => {
              if (process.env.WORKFLOW_EVENT_SOURCE === 'confirmed_operations_v1')
                fields['平台操作标识'] = `op_v1:${job.id}`;
              const marked = await this.serviceRoleDatabase.run((db) =>
                db.execute<{ marked: boolean }>(sql`
                SELECT requirement_update_job_before_write(${job.id}::uuid,${lockToken}::varchar,
                  ${JSON.stringify(before)}::text,${JSON.stringify(fields)}::text,
                  ${String(before.workflow?.version || '')}::varchar) AS marked
              `),
              );
              if (!marked[0]?.marked)
                throw new Error('操作执行权已失效，未继续写入');
              externalWriteStarted = true;
            },
            confirmed: async (before, after, receipt, result) => {
              if (process.env.WORKFLOW_EVENT_SOURCE === 'confirmed_operations_v1' &&
                  after.notificationMarker !== `op_v1:${job.id}`)
                throw new Error('需求写入缺少同次操作标识，已停止后续通知');
              const event = {
                requirementId: job.requirementId,
                actorUserId: job.actorUserId,
                kind:
                  envelope.input.intent === 'status-transition'
                    ? 'status-transition'
                    : 'edit',
                occurredAt: new Date().toISOString(),
                beforeJson: JSON.stringify(before),
                afterJson: JSON.stringify(after),
                fieldsJson: JSON.stringify(result.updatedFields || []),
                requestId: null,
              };
              const completed = await this.serviceRoleDatabase.run((db) =>
                db.execute<{ confirmed: boolean }>(sql`
                SELECT requirement_update_job_confirm(${job.id}::uuid,${lockToken}::varchar,
                  ${JSON.stringify(after)}::text,
                  ${JSON.stringify({ recordId: receipt.record_id, receivedAt: event.occurredAt })}::text,
                  ${JSON.stringify(event)}::jsonb,${JSON.stringify(result)}::text) AS confirmed
              `),
              );
              if (!completed[0]?.confirmed)
                throw new Error('写入回执尚未成功核实');
              externalWriteConfirmed = true;
            },
          },
        ));
      if (externalWriteConfirmed) return;
      const rows = await this.serviceRoleDatabase.run(
        (database: PostgresJsDatabase) =>
          database.execute<{ updated: boolean }>(sql`
            SELECT requirement_update_job_finish(
              ${job.id}::uuid,
              ${lockToken}::varchar,
              'succeeded'::varchar,
              ${JSON.stringify(result)}::text,
              NULL::text
            ) AS updated
          `),
      );
      if (!rows[0]?.updated) {
        throw new Error('更新任务租约已失效，拒绝写回成功结果');
      }
    } catch (error) {
      const message = safeOperationError(
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(`需求更新任务 ${job.id} 失败：${message}`);
      if (
        externalWriteStarted &&
        !(error instanceof ProjectArchivedError) &&
        !(error instanceof FeishuRequestError && error.remoteRejected)
      ) {
        await this.serviceRoleDatabase.run((db) =>
          db.execute(sql`
          SELECT requirement_update_job_uncertain(${job.id}::uuid,${lockToken}::varchar)
        `),
        );
      } else if (!leaseLost) {
        const retryable =
          job.attempts < 3 &&
          error instanceof FeishuRequestError &&
          ((error.remoteRejected &&
            /^feishu_rejected_(429|99991400|99991401|1254607)$/u.test(
              error.errorCode,
            )) ||
            (!externalWriteStarted && !error.remoteRejected));
        if (retryable) {
          await this.serviceRoleDatabase.run((database) =>
            database.execute(sql`UPDATE requirement_update_job
            SET status='queued',execution_stage='retry_wait',error_code='TEMPORARY_DEPENDENCY',error_message=${message},
              available_at=CURRENT_TIMESTAMP+(${Math.min(60, 2 ** job.attempts * 5)}::integer * interval '1 second'),
              lock_token=NULL,lock_expires_at=NULL,_updated_at=CURRENT_TIMESTAMP
            WHERE id=${job.id}::uuid AND status='running' AND lock_token=${lockToken} AND lock_expires_at>CURRENT_TIMESTAMP`),
          );
          return;
        }
        await this.serviceRoleDatabase.run(
          async (database: PostgresJsDatabase) => {
            const finished = await database.execute<{ updated: boolean }>(sql`
            SELECT requirement_update_job_finish(
              ${job.id}::uuid,
              ${lockToken}::varchar,
              'failed'::varchar,
              NULL::text,
              ${message.slice(0, 4_000)}::text
            ) AS updated
          `);
            if (finished[0]?.updated)
              await database.execute(sql`UPDATE requirement_update_job
            SET error_code=${error instanceof BadRequestException || error instanceof ConflictException ? 'BUSINESS_REJECTED' : error instanceof FeishuRequestError ? error.errorCode : 'OPERATION_FAILED'}
            WHERE id=${job.id}::uuid AND status='failed'`);
          },
        );
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async renewLease(jobId: string, lockToken: string): Promise<boolean> {
    const rows = await this.serviceRoleDatabase.run(
      (database: PostgresJsDatabase) =>
        database.execute<{ renewed: boolean }>(sql`
          SELECT requirement_update_job_renew(
            ${jobId}::uuid,
            ${lockToken}::varchar,
            ${new Date(Date.now() + JOB_LEASE_MS)}::timestamptz
          ) AS renewed
        `),
    );
    return rows[0]?.renewed === true;
  }

  private async workerArchivedIds(): Promise<Set<string>> {
    const rows: ArchivedRequirementRow[] = await this.serviceRoleDatabase.run(
      (database: PostgresJsDatabase) =>
        database.execute<ArchivedRequirementRow>(sql`
          SELECT requirement_id FROM requirement_archive_active_ids()
        `),
    );
    return new Set(
      rows.map((row: ArchivedRequirementRow): string => row.requirement_id),
    );
  }

  private async rebuildCurrentUser(
    envelope: UpdateJobEnvelope,
    job: Pick<UpdateJobRecord, 'actorUserId'>,
  ): Promise<CurrentUserSummary> {
    if (!envelope?.input || typeof envelope.input !== 'object') {
      throw new Error('更新任务内容无效，请重新提交');
    }
    const userId: string = job.actorUserId;
    const employeeId: string = await this.platformRoles.employeeId(userId);
    const feishuUser: {
      employeeId: string;
      openId: string;
      name: string;
    } = await this.feishu.getUserByEmployeeId(employeeId);
    if (!feishuUser.openId || !feishuUser.name.trim()) {
      throw new Error('无法重新确认更新任务飞书身份，请重新提交');
    }
    const platformRoleIds: string[] = await this.platformRoles.currentRoles(
      userId,
      process.env.REQUIREMENT_PLATFORM_APP_ID?.trim() ||
        process.env.MIAODA_APP_ID?.trim() ||
        '',
    );
    return this.access.decorate({
      miaodaUserId: userId,
      employeeId: feishuUser.employeeId || employeeId,
      openId: feishuUser.openId,
      name: feishuUser.name.trim(),
      platformAppId:
        process.env.REQUIREMENT_PLATFORM_APP_ID?.trim() ||
        process.env.MIAODA_APP_ID?.trim() ||
        '',
      platformRoleIds,
    });
  }

  async currentActor(actorUserId: string): Promise<CurrentUserSummary> {
    return this.rebuildCurrentUser(
      { input: { expectedUpdatedAt: null, patch: {} } },
      { actorUserId },
    );
  }

  async getAs(
    jobId: string,
    actor: CurrentUserSummary,
  ): Promise<RequirementUpdateJobSummary> {
    const rows = await this.serviceRoleDatabase.run((db) =>
      db.execute<UpdateJobPayloadRow>(sql`
      SELECT to_jsonb(j) AS job FROM requirement_update_job j WHERE id=${jobId}::uuid AND actor_user_id=${actor.miaodaUserId}
    `),
    );
    const job = this.parseJobPayload(rows[0]?.job, '读取');
    if (!job) throw new NotFoundException('未找到该更新任务');
    return this.summary(job);
  }
}
