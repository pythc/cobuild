import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  IterationConfiguration,
  IterationConfigurationVersion,
} from '@shared/iteration-workflow';
import { defaultIterationConfiguration } from '@shared/iteration-workflow';
import {
  defaultIterationAnalysis,
  distributionQuantile,
} from '@shared/iteration-analysis';
import type { IterationEfficiencyResponse } from '@shared/operations-insights.interface';
import { RequirementsQueryService } from '../requirements/requirements-query.service';
import { FeishuService } from '../requirements/feishu.service';
import { linkedIds, textValue } from '../requirements/requirements.model';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import { insightDate } from './operations-insights.model';
import { pullReviewTiming } from './pull-review-timing.model';
import {
  efficiencySnapshot,
  requirementEfficiency,
  type EfficiencyEvent,
  type StageSample,
} from './iteration-efficiency.model';

@Injectable()
export class IterationEfficiencyService {
  constructor(
    private readonly query: RequirementsQueryService,
    private readonly database: ServiceRoleDatabaseExecutor,
    private readonly feishu: FeishuService,
  ) {}
  async get(
    iterationId: string,
    identity: {
      userId: string;
      userName: string;
      roles: string[];
      appId: string;
    },
  ): Promise<IterationEfficiencyResponse> {
    const workspace = await this.query.workspace(identity, false),
      iteration = workspace.iterations.find((item) => item.id === iterationId);
    if (!iteration) throw new NotFoundException('未找到该迭代');
    const visibleIds = workspace.requirements.map((item) => item.id),
      current = workspace.requirements.filter((item) =>
        item.iterationIds.includes(iterationId),
      );
    const data = await this.database.run(async (db) => {
      const configs = await db.execute<{
        published_json: string | null;
        history_json: string;
      }>(
        sql`SELECT published_json,history_json FROM iteration_configuration WHERE iteration_id=${iterationId}`,
      );
      const events = visibleIds.length
        ? await db.execute<Record<string, unknown>>(
            sql`SELECT id,operation_id,requirement_id,workflow_version,confirmed_at,before_json,after_json FROM requirement_business_event WHERE requirement_id IN (${sql.join(
              visibleIds.map((id) => sql`${id}`),
              sql`,`,
            )}) AND (jsonb_exists(before_json::jsonb->'iterationIds', ${iterationId}::text) OR jsonb_exists(after_json::jsonb->'iterationIds', ${iterationId}::text)) ORDER BY confirmed_at,id LIMIT 5001`,
          )
        : [];
      const artifacts = current.length
        ? await db.execute<{ requirement_id: string; kind: string }>(
            sql`SELECT requirement_id,kind FROM requirement_artifact WHERE requirement_id IN (${sql.join(
              current.map((item) => sql`${item.id}`),
              sql`,`,
            )}) AND readable=true AND length(trim(source_snapshot))>0`,
          )
        : [];
      const prs = await db.execute<Record<string, unknown>>(
        sql`SELECT repository,pull_number,title,url,head_ref,reviews_json,review_count,github_created_at,requested_reviewers_json FROM pull_request_snapshot ORDER BY github_updated_at DESC LIMIT 1000`,
      );
      const assignments = await db.execute<Record<string, unknown>>(
        sql`SELECT repository,pull_number,github_login,assignment_generation,_created_at FROM pull_request_reviewer_notification_event ORDER BY _created_at LIMIT 5000`,
      );
      return { configuration: configs[0], events, artifacts, prs, assignments };
    });
    const published = data.configuration?.published_json
      ? (JSON.parse(
          data.configuration.published_json,
        ) as IterationConfigurationVersion)
      : null;
    const config =
        published?.configuration ||
        defaultIterationConfiguration(iteration.milestones || []),
      analysis = config.analysis || defaultIterationAnalysis(config);
    const historyItems: IterationConfigurationVersion[] = JSON.parse(
        data.configuration?.history_json || '[]',
      ),
      history = new Map<number, IterationConfiguration>(
        historyItems.map((item) => [item.version, item.configuration]),
      );
    if (published) history.set(published.version, config);
    const events: EfficiencyEvent[] = data.events.slice(0, 5000).map((row) => ({
      id: String(row.id),
      operationId: row.operation_id ? String(row.operation_id) : null,
      requirementId: String(row.requirement_id),
      at: insightDate(row.confirmed_at)!,
      workflowVersion: row.workflow_version
        ? String(row.workflow_version)
        : null,
      before: efficiencySnapshot(row.before_json),
      after: efficiencySnapshot(row.after_json),
    }));
    const byRequirement = new Map<string, EfficiencyEvent[]>();
    for (const event of events)
      byRequirement.set(event.requirementId, [
        ...(byRequirement.get(event.requirementId) || []),
        event,
      ]);
    const samples: StageSample[] = [];
    const requirements = current.map((item) => {
      const result = requirementEfficiency(
        item,
        byRequirement.get(item.id) || [],
        config,
        history,
        new Set(
          data.artifacts
            .filter((artifact) => artifact.requirement_id === item.id)
            .map((artifact) => artifact.kind),
        ),
        Date.now(),
        iterationId,
      );
      samples.push(...result.samples);
      return result.requirement;
    });
    const coverage = [
      '停留时间依据已确认的状态事件；历史不足显示“未知”，不使用最近更新时间补算。',
      '周一至周五口径不扣除法定节假日；阶段分布仅统计有明确进入与离开事件的阶段。',
      'PR 评审等待仅覆盖平台已记录的 GitHub 指派；不推测平台外缺失的指派历史。',
    ];
    if (workspace.freshness?.stale)
      coverage.push('需求数据当前来自最近可信缓存，风险结论可能滞后。');
    if (data.events.length > 5000)
      coverage.push(
        '状态事件超过本次分析上限，已标记历史截断；请缩小迭代范围后复核。',
      );
    if (!config.analysis)
      coverage.push(
        '使用已公布状态目录的默认统计映射；可以在迭代设置中调整口径。',
      );
    try {
      const relations = await this.feishu.listRecords(
        this.query.table('FEISHU_RELATIONS_TABLE'),
      );
      for (const relation of relations) {
        const type = textValue(relation.fields['关系类型']);
        if (!['依赖', '被依赖'].includes(type)) continue;
        const sources = linkedIds(
            relation.fields[type === '依赖' ? '源需求' : '目标需求'],
          ),
          targets = linkedIds(
            relation.fields[type === '依赖' ? '目标需求' : '源需求'],
          );
        for (const source of sources) {
          const item = requirements.find(
            (candidate) => candidate.id === source,
          );
          if (!item) continue;
          for (const target of targets) {
            const dependency = workspace.requirements.find(
              (candidate) => candidate.id === target,
            );
            if (
              dependency &&
              !['已发布', '已关闭', '已拒绝'].includes(dependency.status)
            )
              item.blockingRequirementIds.push(target);
          }
          item.blockingRequirementIds = [
            ...new Set(item.blockingRequirementIds),
          ];
        }
      }
    } catch {
      coverage.push('依赖关系暂不可用，未据此推断无依赖或无阻塞。');
    }
    const distributions: IterationEfficiencyResponse['distributions'] = [];
    for (const kind of ['requirement', 'defect'] as const)
      for (const stage of ['development', 'testing', 'experience', 'release']) {
        const matched = samples.filter(
          (item) => item.kind === kind && item.stage === stage,
        );
        distributions.push({
          kind,
          stage,
          count: matched.length,
          medianHours: distributionQuantile(
            matched.map((item) => item.hours),
            0.5,
          ),
          p85Hours: distributionQuantile(
            matched.map((item) => item.hours),
            0.85,
          ),
          requirementIds: [
            ...new Set(matched.map((item) => item.requirementId)),
          ],
        });
      }
    const scopeChanges: IterationEfficiencyResponse['scopeChanges'] = [];
    for (const event of events) {
      const before =
          Array.isArray(event.before.iterationIds) &&
          event.before.iterationIds.includes(iterationId),
        after =
          Array.isArray(event.after.iterationIds) &&
          event.after.iterationIds.includes(iterationId);
      if (before !== after)
        scopeChanges.push({
          eventId: event.id,
          operationId: event.operationId,
          requirementId: event.requirementId,
          kind: after ? 'added' : 'removed',
          at: event.at,
        });
    }
    const pullRequests: IterationEfficiencyResponse['pullRequests'] = [];
    for (const pr of data.prs) {
      const linked = current.filter(
        (item) =>
          item.githubPullRequestUrl === pr.url ||
          (item.gitBranchName && item.gitBranchName === pr.head_ref),
      );
      if (!linked.length) continue;
      const reviews = JSON.parse(String(pr.reviews_json || '[]')) as Array<{
          submittedAt?: string;
          author?: { login?: string };
        }>,
        assignments = data.assignments.filter(
          (item) =>
            item.repository === pr.repository &&
            item.pull_number === pr.pull_number,
        );
      const requested = JSON.parse(
        String(pr.requested_reviewers_json || '[]'),
      ) as Array<{ login?: string }>;
      const timing = pullReviewTiming(
        assignments.map((a) => ({
          login: String(a.github_login),
          at: insightDate(a._created_at) || '',
        })),
        reviews.map((r) => ({
          login: r.author?.login || '',
          at: r.submittedAt || '',
        })),
        requested.map((r) => r.login || ''),
        Date.now(),
      );
      pullRequests.push({
        number: Number(pr.pull_number),
        title: String(pr.title),
        requirementIds: linked.map((item) => item.id),
        firstReviewHours: timing.firstReviewHours,
        lastReviewAt:
          reviews
            .map((item) => item.submittedAt)
            .filter((item): item is string => !!item)
            .sort()
            .at(-1) || null,
        waitingReviewHours: timing.waitingReviewHours,
        repeatReviewHours: timing.repeatReviewHours,
        repeatReviewSamples: timing.repeatReviewSamples,
        basis: '平台确认指派 → 对应评审人提交评审',
        complete:
          reviews.length >= Number(pr.review_count) && assignments.length > 0,
      });
    }
    return {
      iterationId,
      iterationName: iteration.name,
      fetchedAt: new Date().toISOString(),
      clock: analysis.clock,
      timezone: analysis.timezone,
      excludeBlockedTime: analysis.excludeBlockedTime,
      configurationVersion: published?.version || null,
      historyMissing: requirements.filter((item) => !item.historyComplete)
        .length,
      requirements,
      distributions,
      scopeChanges,
      pullRequests,
      coverage,
    };
  }
}
