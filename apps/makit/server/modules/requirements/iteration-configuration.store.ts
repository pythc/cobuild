import { isTicketType } from '../../../shared/ticket-workflow';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import { iterationConfiguration } from '../../database/schema';
import {
  iterationConfigurationErrors,
  iterationWorkflowKind,
  type IterationConfiguration,
  type IterationConfigurationVersion,
} from '../../../shared/iteration-workflow';
import type { RequirementSummary } from '@shared/api.interface';

type Row = typeof iterationConfiguration.$inferSelect;
@Injectable()
export class IterationConfigurationStore {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly serviceRoleDatabase: ServiceRoleDatabaseExecutor,
  ) {}

  validate(value: unknown): asserts value is IterationConfiguration {
    const errors = iterationConfigurationErrors(value);
    if (errors.length) throw new BadRequestException(errors.join('；'));
    if (JSON.stringify(value).length > 150_000)
      throw new BadRequestException('迭代配置过大');
  }
  decode<T>(raw: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new ServiceUnavailableException(
        '迭代配置无法读取，请联系管理员，未使用默认规则替代',
      );
    }
  }
  published(
    row: Pick<Row, 'publishedJson'> | null,
  ): IterationConfigurationVersion | null {
    if (!row?.publishedJson) return null;
    const value = this.decode<IterationConfigurationVersion>(row.publishedJson);
    if (
      !value?.configuration ||
      !Number.isInteger(value.version) ||
      value.version < 1 ||
      iterationConfigurationErrors(value.configuration).length
    )
      throw new ServiceUnavailableException('已发布的迭代配置无效');
    return value;
  }
  async read(iterationId: string): Promise<Row | null> {
    const rows = await this.db
      .select()
      .from(iterationConfiguration)
      .where(eq(iterationConfiguration.iterationId, iterationId))
      .limit(1);
    return rows[0] || null;
  }
  async publishedMap(
    iterationId?: string,
  ): Promise<Map<string, IterationConfigurationVersion>> {
    // Published rules are application-wide metadata. Worker calls have no user
    // context; read only these two columns through the existing detached executor.
    // Draft and history reads/writes retain authenticated, admin-restricted RLS.
    const rows = await this.serviceRoleDatabase.run((database) =>
      database.execute<Pick<Row, 'iterationId' | 'publishedJson'>>(
        database
          .select({
            iterationId: sql<string>`${iterationConfiguration.iterationId}`.as(
              'iterationId',
            ),
            publishedJson:
              sql<string>`${iterationConfiguration.publishedJson}`.as(
                'publishedJson',
              ),
          })
          .from(iterationConfiguration)
          .where(
            and(
              isNotNull(iterationConfiguration.publishedJson),
              iterationId
                ? eq(iterationConfiguration.iterationId, iterationId)
                : undefined,
            ),
          ),
      ),
    );
    const result = new Map<string, IterationConfigurationVersion>();
    for (const row of rows) {
      const version = this.published(row);
      if (version) result.set(row.iterationId, version);
    }
    return result;
  }
  decorate(
    requirement: RequirementSummary,
    versions: Map<string, IterationConfigurationVersion>,
  ): void {
    delete requirement.workflow;
    if (isTicketType(requirement.type)) return;
    if (requirement.iterationIds.length !== 1) return;
    const id = requirement.iterationIds[0];
    const version = versions.get(id);
    if (!version) return;
    const flow =
      version.configuration.workflows[iterationWorkflowKind(requirement.type)];
    requirement.workflow = {
      ...flow,
      iterationId: id,
      version: version.version,
    };
    requirement.allowedStatuses = flow.transitions
      .filter((edge) => edge.from === requirement.status)
      .map((edge) => edge.to)
      .sort(
        (left, right) =>
          flow.statuses.indexOf(left) - flow.statuses.indexOf(right),
      );
  }
  async assertVersion(iterationId: string, version: number): Promise<void> {
    if (
      ((await this.publishedMap(iterationId)).get(iterationId)?.version ||
        0) !== version
    )
      throw new ConflictException('迭代规则已更新，请核对最新规则后重试');
  }
  async save(
    iterationId: string,
    expectedRevision: number,
    draft: IterationConfiguration,
    publishBy?: string,
  ): Promise<void> {
    this.validate(draft);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      throw new BadRequestException('缺少有效配置版本');
    const row = await this.read(iterationId);
    if ((row?.revision || 0) !== expectedRevision)
      throw new ConflictException(
        '配置已被修改，草稿已保留在页面，请重新加载后核对',
      );
    const history = row
      ? this.decode<IterationConfigurationVersion[]>(row.historyJson)
      : [];
    if (!Array.isArray(history))
      throw new ServiceUnavailableException(
        '迭代配置版本记录无效，未覆盖原数据',
      );
    const published = publishBy
      ? {
          version: (this.published(row)?.version || 0) + 1,
          publishedAt: new Date().toISOString(),
          publishedBy: publishBy,
          configuration: draft,
        }
      : this.published(row);
    if (publishBy && published) history.push(published);
    const values = {
      draftJson: JSON.stringify(draft),
      publishedJson: published ? JSON.stringify(published) : null,
      historyJson: JSON.stringify(history),
      revision: expectedRevision + 1,
    };
    const saved = row
      ? await this.db
          .update(iterationConfiguration)
          .set(values)
          .where(
            and(
              eq(iterationConfiguration.iterationId, iterationId),
              eq(iterationConfiguration.revision, expectedRevision),
            ),
          )
          .returning({ id: iterationConfiguration.id })
      : await this.db
          .insert(iterationConfiguration)
          .values({ iterationId, ...values })
          .onConflictDoNothing()
          .returning({ id: iterationConfiguration.id });
    if (!saved.length)
      throw new ConflictException('配置已被修改，请重新加载后核对');
  }
}
