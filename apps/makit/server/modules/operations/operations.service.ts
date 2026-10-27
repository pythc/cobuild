import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import type {
  OperationListQuery,
  OperationListResponse,
  OperationsAccess,
  OperationsReviewListResponse,
  RequirementUpdateJobStatus,
} from '@shared/api.interface';
import {
  requirementUpdateJob,
  requirementAiReview,
} from '../../database/schema';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import {
  operationDate,
  operationRecord,
  safeOperationError,
  type StoredOperation,
} from './operations.model';

@Injectable()
export class OperationsService {
  constructor(private readonly database: ServiceRoleDatabaseExecutor) {}

  async list(
    access: OperationsAccess,
    query: OperationListQuery,
  ): Promise<OperationListResponse> {
    const scope: 'mine' | 'all' =
      query.scope === 'all' && access.canViewAll ? 'all' : 'mine';
    const page: number = query.page || 1;
    const pageSize: number = query.pageSize || 25;
    const filters: SQL[] = [];
    // Always filter inside SQL, before count and pagination; never fetch all users then hide rows.
    if (scope === 'mine')
      filters.push(eq(requirementUpdateJob.actorUserId, access.userId));
    if (query.requirementId)
      filters.push(eq(requirementUpdateJob.requirementId, query.requirementId));
    if (query.operationId)
      filters.push(eq(requirementUpdateJob.id, query.operationId));
    if (query.requirementCode)
      filters.push(sql`EXISTS(SELECT 1 FROM requirement_business_event e
      WHERE e.requirement_id=${requirementUpdateJob.requirementId} AND e.after_json::jsonb->>'code'=${query.requirementCode})`);
    if (query.pullNumber)
      filters.push(sql`EXISTS(SELECT 1 FROM requirement_business_event e
      WHERE e.requirement_id=${requirementUpdateJob.requirementId} AND e.after_json::jsonb->>'githubPullRequestUrl' LIKE ${`%/pull/${query.pullNumber}`})`);
    if (query.since)
      filters.push(
        sql`${requirementUpdateJob.createdAt}>=${query.since}::timestamptz`,
      );
    if (query.until)
      filters.push(
        sql`${requirementUpdateJob.createdAt}<=${query.until}::timestamptz`,
      );
    const stats: OperationListResponse['stats'] = {
      total: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      unknown: 0,
    };
    const grouped = await this.database.run((db) =>
      db.execute<{ status: string; count: number }>(
        db
          .select({ status: requirementUpdateJob.status, count: count() })
          .from(requirementUpdateJob)
          .where(and(...filters))
          .groupBy(requirementUpdateJob.status),
      ),
    );
    for (const group of grouped) {
      if (
        ['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(
          group.status,
        )
      ) {
        stats[group.status as RequirementUpdateJobStatus] = Number(group.count);
        stats.total += Number(group.count);
      }
    }
    if (query.status && query.status !== 'all')
      filters.push(eq(requirementUpdateJob.status, query.status));
    const total: number =
      query.status && query.status !== 'all'
        ? stats[query.status]
        : stats.total;
    const rows: StoredOperation[] = await this.database.run((db) =>
      db.execute<StoredOperation>(
        db
          .select({
            id: requirementUpdateJob.id,
            requirementId: sql`${requirementUpdateJob.requirementId}`.as(
              'requirementId',
            ),
            actorUserId: sql`${requirementUpdateJob.actorUserId}`.as(
              'actorUserId',
            ),
            actorUserName: sql`${requirementUpdateJob.actorUserName}`.as(
              'actorUserName',
            ),
            inputJson: sql`${requirementUpdateJob.inputJson}`.as('inputJson'),
            resultJson: sql`${requirementUpdateJob.resultJson}`.as(
              'resultJson',
            ),
            errorMessage: sql`${requirementUpdateJob.errorMessage}`.as(
              'errorMessage',
            ),
            createdAt: sql`${requirementUpdateJob.createdAt}`.as('createdAt'),
            finishedAt: sql`${requirementUpdateJob.finishedAt}`.as(
              'finishedAt',
            ),
            status: requirementUpdateJob.status,
            attempts: requirementUpdateJob.attempts,
          })
          .from(requirementUpdateJob)
          .where(and(...filters))
          .orderBy(
            desc(requirementUpdateJob.createdAt),
            desc(requirementUpdateJob.id),
          )
          .limit(pageSize)
          .offset((page - 1) * pageSize),
      ),
    );
    const items = rows.map(operationRecord);
    if (items.length) {
      const ids = sql.join(
        items.map((item) => sql`${item.id}::uuid`),
        sql`,`,
      );
      const ownedIds = sql`SELECT ${requirementUpdateJob.id} FROM ${requirementUpdateJob}
        WHERE ${requirementUpdateJob.id} IN (${ids}) AND ${scope === 'mine' ? eq(requirementUpdateJob.actorUserId,access.userId) : sql`true`}`;
      // Delivery IDs also support native events and are varchar, not UUID.
      // Cast the authorized UUID projection, never the potentially non-UUID delivery column.
      const ownedTextIds = sql`SELECT owned_operation.id::text FROM (${ownedIds}) owned_operation`;
      // Only enrich already authorized rows; never expose event/document JSON.
      const metadata = await this.database.run((db) =>
        db.execute<{
          id: string;
          code: string;
          source: string;
          trace_id: string;
          execution_stage: string;
          workflow_version: string;
        }>(sql`
        SELECT j.id,COALESCE(j.after_json::jsonb->>'code',j.before_json::jsonb->>'code','') AS code,
          j.source,j.trace_id,j.execution_stage,j.workflow_version FROM requirement_update_job j WHERE j.id IN(${ownedIds})`),
      );
      const consumers = await this.database.run((db) =>
        db.execute<{
          operation_id: string;
          consumer: string;
          status: string;
        }>(sql`
        SELECT operation_id,consumer,status FROM requirement_operation_outbox WHERE operation_id IN(${ownedIds})`),
      );
      const deliveries = await this.database.run((db) =>
        db.execute<{ operation_id: string; state: string; count: number }>(sql`
        SELECT operation_id,state,count(*) AS count FROM notification_delivery WHERE operation_id IN(${ownedTextIds}) GROUP BY operation_id,state`),
      );
      for (const item of items) {
        const meta = metadata.find((row) => row.id === item.id);
        if (meta)
          Object.assign(item, {
            requirementCode: meta.code,
            source: meta.source,
            traceId: meta.trace_id,
            executionStage: meta.execution_stage,
            workflowVersion: meta.workflow_version,
          });
        for (const stage of item.stages) {
          const consumer = consumers.find(
            (row) => row.operation_id === item.id && row.consumer === stage.key,
          );
          if (!consumer) continue;
          stage.status =
            consumer.status === 'succeeded'
              ? 'succeeded'
              : consumer.status === 'failed'
                ? 'failed'
                : consumer.status === 'unknown'
                  ? 'unknown'
                  : 'pending';
          stage.detail = {
            succeeded: '已确认',
            failed: '此环节未完成，可单独恢复，不重复修改需求',
            unknown: '结果待核实，不会盲目重试',
            pending: '等待处理',
          }[stage.status];
          if (stage.key === 'review' && stage.status === 'succeeded')
            stage.detail = '触发检查已完成；评审结果请查看 AI 评审记录';
          if (stage.key === 'notification' && consumer.status === 'succeeded') {
            const targets = deliveries.filter(
              (row) => row.operation_id === item.id,
            );
            if (!targets.length) {
              stage.detail = '本次没有应发送的通知';
            } else if (targets.every((row) => row.state === 'shadow')) {
              stage.status = 'unknown';
              stage.detail =
                '核对记录未外发；真实投递由协作扫描器记录，尚无同事务标识可证明归属';
            } else {
              stage.status = targets.some((row) => row.state === 'unknown')
                ? 'unknown'
                : targets.some((row) => row.state === 'failed')
                  ? 'failed'
                  : targets.every((row) =>
                        ['sent', 'suppressed'].includes(row.state),
                      )
                    ? 'succeeded'
                    : 'pending';
              stage.detail = targets
                .map(
                  (row) =>
                    `${({ sent: '已发送', suppressed: '策略跳过', unknown: '待核实', failed: '失败', pending: '待发送', sending: '发送中', retry_wait: '待重试', shadow: '核对记录' } as Record<string, string>)[row.state] || '未知'} ${row.count}`,
                )
                .join(' · ');
            }
          }
        }
      }
    }
    return {
      fetchedAt: new Date().toISOString(),
      scope,
      items,
      stats,
      page,
      pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async reviews(
    page: number,
    pageSize: number,
  ): Promise<OperationsReviewListResponse> {
    const rows = await this.database.run((db) =>
      db.execute<{
        id: string;
        requirementId: string;
        reviewType: string;
        status: string;
        score: number | null;
        attempts: number;
        errorMessage: string;
        updatedAt: Date;
      }>(
        db
          .select({
            id: requirementAiReview.id,
            requirementId: sql`${requirementAiReview.requirementId}`.as(
              'requirementId',
            ),
            reviewType: sql`${requirementAiReview.reviewType}`.as('reviewType'),
            status: requirementAiReview.status,
            score: requirementAiReview.score,
            attempts: requirementAiReview.attempts,
            errorMessage: sql`${requirementAiReview.errorMessage}`.as(
              'errorMessage',
            ),
            updatedAt: sql`${requirementAiReview.updatedAt}`.as('updatedAt'),
          })
          .from(requirementAiReview)
          .orderBy(
            desc(requirementAiReview.updatedAt),
            desc(requirementAiReview.id),
          )
          .limit(pageSize)
          .offset((page - 1) * pageSize),
      ),
    );
    const totals = await this.database.run((db) =>
      db.execute<{ count: number }>(
        db.select({ count: count() }).from(requirementAiReview),
      ),
    );
    const total: number = Number(totals[0]?.count || 0);
    return {
      items: rows.map((row) => ({
        ...row,
        errorMessage: safeOperationError(row.errorMessage),
        updatedAt: operationDate(row.updatedAt),
      })),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  }
}
