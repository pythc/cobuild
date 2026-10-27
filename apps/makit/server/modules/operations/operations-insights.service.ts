import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  AiExecutionsResponse,
  AiExecutionSummary,
  OperationsSettings,
} from '@shared/operations-insights.interface';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import { OperationsSettingsService } from './operations-settings.service';
import {
  insightDate,
  validateOperationsSettings,
} from './operations-insights.model';
const numberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
@Injectable()
export class OperationsInsightsService {
  private readonly logger = new Logger(OperationsInsightsService.name);
  constructor(
    private readonly database: ServiceRoleDatabaseExecutor,
    private readonly settings: OperationsSettingsService,
  ) {}
  async executions(
    page = 1,
    days = 7,
    requirementId?: string,
  ): Promise<AiExecutionsResponse> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const where = requirementId
      ? sql`AND r.requirement_id = ${requirementId}`
      : sql``;
    const settings = await this.settings.get();
    const result = await this.database.run(async (db) => {
      const items = await db.execute<Record<string, unknown>>(
        sql`SELECT e.*, r.requirement_id, r.review_type FROM requirement_ai_review_execution e JOIN requirement_ai_review r ON r.id=e.review_id WHERE e.started_at >= ${since}::timestamptz ${where} ORDER BY e.started_at DESC,e.id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`,
      );
      const aggregates = await db.execute<Record<string, unknown>>(
        sql`SELECT count(*)::int AS count, COALESCE(sum(e.input_tokens),0) AS input, COALESCE(sum(e.output_tokens),0) AS output, count(*) FILTER (WHERE e.input_tokens IS NULL OR e.output_tokens IS NULL)::int AS unknown_usage, count(*) FILTER (WHERE e.estimated_cost IS NULL)::int AS unknown_cost FROM requirement_ai_review_execution e JOIN requirement_ai_review r ON r.id=e.review_id WHERE e.started_at >= ${since}::timestamptz ${where}`,
      );
      const costs = await db.execute<{ currency: string; amount: string }>(
        sql`SELECT e.currency, sum(e.estimated_cost)::text AS amount FROM requirement_ai_review_execution e JOIN requirement_ai_review r ON r.id=e.review_id WHERE e.started_at >= ${since}::timestamptz ${where} AND e.estimated_cost IS NOT NULL GROUP BY e.currency`,
      );
      const daily = await db.execute<{ cost: string }>(
        sql`SELECT COALESCE(sum(estimated_cost),0)::text AS cost FROM requirement_ai_review_execution WHERE started_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AND currency = ${settings.ai.pricing?.currency || ''}`,
      );
      return {
        items,
        aggregates: aggregates[0] || {},
        costs,
        daily: Number(daily[0]?.cost || 0),
      };
    });
    return {
      page,
      total: Number(result.aggregates.count || 0),
      pageCount: Math.max(
        1,
        Math.ceil(Number(result.aggregates.count || 0) / 25),
      ),
      items: result.items.map(
        (row): AiExecutionSummary => ({
          id: String(row.id),
          reviewId: String(row.review_id),
          requirementId: String(row.requirement_id),
          batchId: String(row.batch_id),
          attempt: Number(row.attempt),
          reviewType: String(row.review_type),
          sourceHash: String(row.source_hash),
          model: String(row.model),
          ruleSetVersion: String(row.rule_set_version),
          status: String(row.status),
          startedAt: insightDate(row.started_at)!,
          finishedAt: insightDate(row.finished_at),
          inputTokens: numberOrNull(row.input_tokens),
          outputTokens: numberOrNull(row.output_tokens),
          cacheHitTokens: numberOrNull(row.cache_hit_tokens),
          pricingVersion: row.pricing_version
            ? String(row.pricing_version)
            : null,
          estimatedCost: numberOrNull(row.estimated_cost),
          currency: row.currency ? String(row.currency) : null,
          errorCode: row.error_code ? String(row.error_code) : null,
          errorMessage: row.error_message ? String(row.error_message) : null,
          feedback: row.feedback as AiExecutionSummary['feedback'],
          feedbackReason: row.feedback_reason
            ? String(row.feedback_reason)
            : null,
        }),
      ),
      usage: {
        executionCount: Number(result.aggregates.count || 0),
        inputTokens: Number(result.aggregates.input || 0),
        outputTokens: Number(result.aggregates.output || 0),
        unknownUsageCount: Number(result.aggregates.unknown_usage || 0),
        unknownCostCount: Number(result.aggregates.unknown_cost || 0),
        estimatedCosts: result.costs.map((row) => ({
          currency: row.currency,
          amount: Number(row.amount),
        })),
        budgetExceeded:
          settings.ai.dailyBudget !== null &&
          result.daily > settings.ai.dailyBudget,
      },
    };
  }

  async feedback(
    id: string,
    actorUserId: string,
    feedback: 'adopted' | 'ignored',
    reason: string,
  ): Promise<void> {
    const rows = await this.database.run((db) =>
      db.execute(
        sql`UPDATE requirement_ai_review_execution SET feedback=${feedback}, feedback_reason=${reason}, feedback_user_id=${actorUserId}, feedback_at=NOW(), _updated_at=NOW() WHERE id=${id}::uuid AND status IN ('completed','stale') RETURNING id`,
      ),
    );
    if (!rows.length)
      throw new BadRequestException('只能对已完成的评审记录反馈');
  }

  async saveSettings(
    settingsInput: unknown,
    actorUserId: string,
  ): Promise<OperationsSettings> {
    const settings = validateOperationsSettings(settingsInput);
    if (settings.alerts.enabled)
      throw new BadRequestException('监测功能已移除，无法启用告警');
    const saved = await this.settings.save(settings, actorUserId);
    this.logger.log(
      JSON.stringify({
        event: 'operations_settings_changed',
        actorUserId,
        revision: saved.revision,
      }),
    );
    return saved;
  }
}
