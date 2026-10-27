import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CurrentUserSummary } from '@shared/api.interface';
import {
  defaultIterationConfiguration,
  iterationWorkflowKind,
  type IterationConfiguration,
  type IterationSettingsImpact,
  type IterationSettingsInput,
  type IterationSettingsResponse,
  type IterationConfigurationVersion,
} from '../../../shared/iteration-workflow';
import { IterationConfigurationStore } from './iteration-configuration.store';
import { RequirementsQueryService } from './requirements-query.service';
import { RequirementAccessService } from './requirement-access.service';

@Injectable()
export class IterationSettingsService {
  constructor(
    private readonly store: IterationConfigurationStore,
    private readonly query: RequirementsQueryService,
    private readonly access: RequirementAccessService,
  ) {}
  private admin(actor: CurrentUserSummary): void {
    this.access.assertCanCreate(actor);
  }
  async get(
    id: string,
    actor: CurrentUserSummary,
  ): Promise<IterationSettingsResponse> {
    this.admin(actor);
    const context = await this.query.requirementEditContext(false);
    const iteration = context.iterations.find((item) => item.id === id);
    if (!iteration) throw new NotFoundException('未找到该迭代');
    const row = await this.store.read(id);
    const milestones = [
      ['start', '迭代开始', iteration.startAt],
      ['review', '需求评审', iteration.reviewAt],
      ['development', '开发启动', iteration.developmentAt],
      ['testing', '提测', iteration.testingAt],
      ['release', '正式发布', iteration.releaseAt || iteration.endAt],
    ].map(([key, name, date]) => ({
      id: String(key),
      name: String(name),
      dueAt:
        date && Number.isFinite(new Date(date).getTime())
          ? new Date(date).toISOString()
          : null,
    }));
    return {
      iterationId: id,
      iterationName: iteration.name,
      revision: row?.revision || 0,
      draft: row
        ? this.store.decode<IterationConfiguration>(row.draftJson)
        : defaultIterationConfiguration(milestones),
      published: this.store.published(row),
      history: row
        ? this.store.decode<IterationConfigurationVersion[]>(row.historyJson)
        : [],
    };
  }
  async impact(
    id: string,
    configuration: IterationConfiguration,
    actor: CurrentUserSummary,
  ): Promise<IterationSettingsImpact> {
    this.admin(actor);
    this.store.validate(configuration);
    const workspace = await this.query.workspaceAs(actor, true);
    if (!workspace.iterations.some((item) => item.id === id))
      throw new NotFoundException('未找到该迭代');
    const requirements = workspace.requirements.filter((item) =>
      item.iterationIds.includes(id),
    );
    const errors = requirements.flatMap((item) => {
      if (item.iterationIds.length > 1)
        return [`${item.code || item.title} 同时属于多个迭代，请先明确归属`];
      if (
        !configuration.workflows[
          iterationWorkflowKind(item.type)
        ].statuses.includes(item.status)
      )
        return [
          `${item.code || item.title} 正在使用“${item.status}”，不能移除此状态`,
        ];
      return [];
    });
    const current = this.store.published(
      await this.store.read(id),
    )?.configuration;
    const changes: string[] = [];
    for (const kind of ['requirement', 'defect'] as const)
      if (
        JSON.stringify(current?.workflows[kind]) !==
        JSON.stringify(configuration.workflows[kind])
      )
        changes.push(`${kind === 'defect' ? '缺陷' : '需求'}工作流将更新`);
    if (
      JSON.stringify(current?.milestones) !==
      JSON.stringify(configuration.milestones)
    )
      changes.push('里程碑将更新');
    return {
      valid: errors.length === 0,
      requirementCount: requirements.length,
      errors,
      changes,
    };
  }
  async save(
    id: string,
    input: IterationSettingsInput,
    actor: CurrentUserSummary,
    publish = false,
  ): Promise<IterationSettingsResponse> {
    this.admin(actor);
    if (!input) throw new BadRequestException('缺少迭代配置');
    await this.get(id, actor);
    this.store.validate(input.configuration);
    if (publish) {
      const impact = await this.impact(id, input.configuration, actor);
      if (!impact.valid)
        throw new BadRequestException(impact.errors.join('；'));
    }
    await this.store.save(
      id,
      input.expectedRevision,
      input.configuration,
      publish ? actor.name || '管理员' : undefined,
    );
    this.query.invalidate();
    return this.get(id, actor);
  }
}
