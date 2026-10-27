import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  CurrentUserSummary,
  RequirementUpdateJobStatus,
} from '@shared/api.interface';
import type {
  RequirementBatch,
  RequirementBatchItem,
  RequirementBatchPreviewInput,
} from '@shared/requirement-batch';
import { prepareOperationInput } from '@shared/requirement-operation';
import { operationRequestHash } from './requirement-operation.model';
import {
  requirementUpdateBatch,
  requirementUpdateJob,
} from '../../database/schema';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import { RequirementsQueryService } from './requirements-query.service';
import { RequirementsCommandService } from './requirements-command.service';
import { RequirementUpdateJobsService } from './requirement-update-jobs.service';
import { safeOperationError } from '../operations/operations.model';

interface BatchRow extends Record<string, unknown> {
  id: string;
  actor_user_id: string;
  status: RequirementBatch['state'];
  preview_json: string;
  patch_json: string;
  expires_at: string;
  request_hash: string;
}
@Injectable()
export class RequirementBatchService {
  constructor(
    private readonly database: ServiceRoleDatabaseExecutor,
    private readonly query: RequirementsQueryService,
    private readonly command: RequirementsCommandService,
    private readonly jobs: RequirementUpdateJobsService,
  ) {}

  async preview(
    input: RequirementBatchPreviewInput,
    actor: CurrentUserSummary,
  ): Promise<RequirementBatch> {
    if (
      !input ||
      !/^[a-zA-Z0-9_-]{8,128}$/u.test(input.clientMutationId) ||
      !Array.isArray(input.items) ||
      input.items.length < 1 ||
      input.items.length > 100 ||
      !input.patch ||
      typeof input.patch !== 'object' ||
      Array.isArray(input.patch) ||
      input.items.some(
        (item) =>
          !item ||
          !/^rec[A-Za-z0-9]{1,80}$/u.test(item.recordId || '') ||
          (item.expectedUpdatedAt !== null &&
            typeof item.expectedUpdatedAt !== 'string' &&
            !(
              typeof item.expectedUpdatedAt === 'number' &&
              Number.isFinite(item.expectedUpdatedAt)
            )),
      ) ||
      !Object.keys(input.patch).length ||
      Object.entries(input.patch).some(([key, value]) =>
        key === 'iterationIds'
          ? !Array.isArray(value) ||
            value.length > 1 ||
            value.some(
              (id) => typeof id !== 'string' || !/^rec[A-Za-z0-9]+$/u.test(id),
            )
          : typeof value !== 'string',
      ) ||
      Object.keys(input.patch).some(
        (key) =>
          !['status', 'priority', 'project', 'iterationIds'].includes(key),
      ) ||
      new Set(input.items.map((item) => item.recordId)).size !==
        input.items.length
    )
      throw new BadRequestException('批量修改参数无效');
    if (['待发布', '已发布', '已关闭'].includes(input.patch.status || ''))
      throw new BadRequestException('发布或关闭请逐条确认，不支持批量跳过门禁');
    const hash =
      operationRequestHash('batch', {
        expectedUpdatedAt: null,
        patch: input.patch,
        baseValues: {},
        clientMutationId: input.clientMutationId,
        source: 'bulk',
      }) +
      ':' +
      input.items
        .map((item) => item.recordId + ':' + item.expectedUpdatedAt)
        .join('|');
    // Hash the complete immutable preview, including order and expected versions.
    const requestHash = operationRequestHash('batch', {
      expectedUpdatedAt: hash,
      patch: input.patch,
    });
    const previous = await this.database.run((db) =>
      db.execute<BatchRow>(sql`SELECT * FROM ${requirementUpdateBatch}
      WHERE actor_user_id=${actor.miaodaUserId} AND client_mutation_id=${input.clientMutationId}`),
    );
    if (previous[0]) {
      if (previous[0].request_hash !== requestHash)
        throw new ConflictException('同一批次标识包含不同修改');
      return this.get(previous[0].id, actor);
    }
    const items: RequirementBatchItem[] = [];
    const workflows = new Set<string>();
    for (const item of input.items) {
      try {
        const current = await this.query.requirementByIdAs(
          item.recordId,
          actor,
        );
        const operation = prepareOperationInput(current, {
          expectedUpdatedAt: item.expectedUpdatedAt,
          patch: input.patch,
          source: 'bulk',
          intent: input.patch.status ? 'status-transition' : 'edit',
        });
        if (
          String(item.expectedUpdatedAt ?? '') !==
          String(current.updatedAt ?? '')
        )
          throw new ConflictException('该需求已更新，请重新选择并预览');
        const result = await this.command.preflightRequirementUpdateAs(
          item.recordId,
          operation,
          actor,
        );
        workflows.add(
          `${current.workflow?.iterationId || 'default'}:${current.workflow?.version || 0}:${current.type}`,
        );
        items.push({
          recordId: item.recordId,
          code: current.code,
          title: current.title,
          input: operation,
          status: result.updatedFields?.length === 0 ? 'skipped' : 'allowed',
          reason: result.updatedFields?.length === 0 ? '内容未变化' : '',
        });
      } catch (error) {
        items.push({
          recordId: item.recordId,
          code: '',
          title: '待重新确认的需求',
          status: 'blocked',
          reason: safeOperationError(
            error instanceof Error ? error.message : '',
          ),
          input: {
            expectedUpdatedAt: item.expectedUpdatedAt,
            patch: input.patch,
          },
        });
      }
    }
    if (input.patch.status && workflows.size > 1)
      for (const item of items)
        if (item.status === 'allowed') {
          item.status = 'blocked';
          item.reason = '这些需求的迭代流程不同，请按相同流程分批操作';
        }
    const rows = await this.database.run((db) =>
      db.execute<BatchRow>(sql`INSERT INTO ${requirementUpdateBatch}
      (actor_user_id,client_mutation_id,request_hash,patch_json,preview_json,expires_at)
      VALUES(${actor.miaodaUserId},${input.clientMutationId},${requestHash},${JSON.stringify(input.patch)},${JSON.stringify(items)},CURRENT_TIMESTAMP+interval '10 minutes')
      ON CONFLICT(actor_user_id,client_mutation_id) DO NOTHING RETURNING *`),
    );
    if (!rows[0]) return this.preview(input, actor);
    return this.project(rows[0], items);
  }

  async get(id: string, actor: CurrentUserSummary): Promise<RequirementBatch> {
    const row = await this.row(id, actor);
    const items: RequirementBatchItem[] = JSON.parse(row.preview_json);
    const keys = items.map((item) => `${id}_${item.recordId}`);
    const operations = await this.database.run((db) =>
      db.execute<{
        id: string;
        client_mutation_id: string;
        status: RequirementUpdateJobStatus;
        error_message: string | null;
      }>(sql`
      SELECT id,client_mutation_id,status,error_message FROM ${requirementUpdateJob}
      WHERE actor_user_id=${actor.miaodaUserId} AND client_mutation_id IN(${sql.join(
        keys.map((key) => sql`${key}`),
        sql`,`,
      )})`),
    );
    const map = new Map(
      operations.map((operation) => [operation.client_mutation_id, operation]),
    );
    for (const item of items) {
      const operation = map.get(`${id}_${item.recordId}`);
      if (operation) {
        item.operationId = operation.id;
        item.status = operation.status;
        item.reason = safeOperationError(operation.error_message);
      }
    }
    return this.project(row, items);
  }

  async execute(
    id: string,
    actor: CurrentUserSummary,
  ): Promise<RequirementBatch> {
    const row = await this.row(id, actor);
    if (row.status === 'submitted') return this.get(id, actor);
    if (
      new Date(row.expires_at).getTime() < Date.now() &&
      row.status === 'preview'
    )
      throw new ConflictException('预览已过期，请重新预览');
    if (row.status === 'preview') {
      const started = await this.database.run((db) =>
        db.execute<{
          id: string;
        }>(sql`UPDATE ${requirementUpdateBatch} SET status='executing',_updated_at=CURRENT_TIMESTAMP
        WHERE id=${id}::uuid AND actor_user_id=${actor.miaodaUserId} AND status='preview' AND expires_at>CURRENT_TIMESTAMP RETURNING id`),
      );
      if (!started.length) {
        const latest = await this.row(id, actor);
        if (latest.status === 'preview')
          throw new ConflictException('预览已过期，请重新预览');
        return this.get(id, actor);
      }
    }
    const items: RequirementBatchItem[] = JSON.parse(row.preview_json);
    for (const item of items) {
      if (item.status !== 'allowed') continue;
      try {
        const accepted = await this.jobs.enqueueAs(
          item.recordId,
          {
            ...item.input,
            clientMutationId: `${id}_${item.recordId}`,
            source: 'bulk',
          },
          actor,
        );
        item.operationId = accepted.jobId;
        item.status = accepted.jobStatus;
      } catch (error) {
        item.status = 'failed';
        item.reason = safeOperationError(
          error instanceof Error ? error.message : '',
        );
      }
    }
    await this.database.run((db) =>
      db.execute(sql`UPDATE ${requirementUpdateBatch} SET status='submitted',preview_json=${JSON.stringify(items)},_updated_at=CURRENT_TIMESTAMP
      WHERE id=${id}::uuid AND actor_user_id=${actor.miaodaUserId}`),
    );
    return this.get(id, actor);
  }

  async retryPreview(
    id: string,
    actor: CurrentUserSummary,
    clientMutationId: string,
  ): Promise<RequirementBatch> {
    const previous = await this.get(id, actor);
    const failed = previous.items.filter((item) => item.status === 'failed');
    if (!failed.length)
      throw new BadRequestException(
        '没有可重试的失败项；待核实和成功项不会重放',
      );
    const items = [];
    for (const item of failed) {
      const current = await this.query.requirementByIdAs(item.recordId, actor);
      items.push({
        recordId: item.recordId,
        expectedUpdatedAt: current.updatedAt,
      });
    }
    return this.preview(
      { clientMutationId, items, patch: previous.patch },
      actor,
    );
  }

  private async row(id: string, actor: CurrentUserSummary): Promise<BatchRow> {
    if (!/^[0-9a-f-]{36}$/iu.test(id))
      throw new BadRequestException('批次标识无效');
    const rows = await this.database.run((db) =>
      db.execute<BatchRow>(
        sql`SELECT * FROM ${requirementUpdateBatch} WHERE id=${id}::uuid AND actor_user_id=${actor.miaodaUserId}`,
      ),
    );
    if (!rows[0]) throw new NotFoundException('未找到该批次');
    return rows[0];
  }
  private project(
    row: BatchRow,
    items: RequirementBatchItem[],
  ): RequirementBatch {
    return {
      id: row.id,
      state: row.status,
      expiresAt: new Date(row.expires_at).toISOString(),
      patch: JSON.parse(row.patch_json),
      items,
    };
  }
}
