import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { CurrentUserSummary } from '@shared/api.interface';
import {
  validateSavedViewConfig,
  type WorkspaceSavedView,
  type WorkspaceSavedViewInput,
  type WorkspaceSavedViewsResponse,
} from '../../../shared/workspace-efficiency';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import { workspaceSavedView } from '../../database/schema';
import { RequirementAccessService } from '../requirements/requirement-access.service';

type Row = Pick<
  typeof workspaceSavedView.$inferSelect,
  'id' | 'ownerUserId' | 'scope' | 'name' | 'configJson' | 'version'
>;
// The service-role executor returns raw SQL rows, so camelCase aliases are explicit.
const VIEW_COLUMNS = {
  id: workspaceSavedView.id,
  scope: workspaceSavedView.scope,
  name: workspaceSavedView.name,
  version: workspaceSavedView.version,
  ownerUserId: sql<string>`${workspaceSavedView.ownerUserId}`.as('ownerUserId'),
  configJson: sql<string>`${workspaceSavedView.configJson}`.as('configJson'),
};

@Injectable()
export class WorkspaceViewsService {
  constructor(
    private readonly database: ServiceRoleDatabaseExecutor,
    private readonly access: RequirementAccessService,
  ) {}

  private user(actor: CurrentUserSummary): string {
    if (!actor.miaodaUserId) throw new ForbiddenException('请先登录');
    return actor.miaodaUserId;
  }

  private dto(row: Row, actor: CurrentUserSummary): WorkspaceSavedView {
    let config: unknown;
    try {
      config = JSON.parse(row.configJson);
    } catch {
      throw new BadRequestException('视图配置损坏，请重新保存');
    }
    if (!validateSavedViewConfig(config))
      throw new BadRequestException('视图配置不兼容，请重新保存');
    return {
      id: row.id,
      ownerUserId: row.ownerUserId,
      scope: row.scope as 'personal' | 'team',
      name: row.name,
      config,
      version: row.version,
      canEdit:
        row.scope === 'personal'
          ? row.ownerUserId === actor.miaodaUserId
          : this.access.canCollaborate(actor),
    };
  }

  async list(actor: CurrentUserSummary): Promise<WorkspaceSavedViewsResponse> {
    const userId = this.user(actor);
    const rows = await this.database.run((db) =>
      db.execute<Row>(
        db
          .select(VIEW_COLUMNS)
          .from(workspaceSavedView)
          .where(
            or(
              eq(workspaceSavedView.ownerUserId, userId),
              eq(workspaceSavedView.scope, 'team'),
            ),
          )
          .orderBy(desc(workspaceSavedView.updatedAt))
          .limit(200),
      ),
    );
    return {
      userId,
      items: rows.map((row) => this.dto(row, actor)),
      canManageTeamViews: this.access.canCollaborate(actor),
    };
  }

  private validate(input: WorkspaceSavedViewInput): void {
    if (
      !input ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.trim().length > 120 ||
      !['personal', 'team'].includes(input.scope) ||
      !validateSavedViewConfig(input.config)
    ) {
      throw new BadRequestException('请填写有效视图名称和筛选条件');
    }
    if (
      input.expectedVersion !== undefined &&
      (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)
    )
      throw new BadRequestException('视图版本无效');
  }

  async save(
    actor: CurrentUserSummary,
    input: WorkspaceSavedViewInput,
    id?: string,
  ): Promise<WorkspaceSavedView> {
    const userId = this.user(actor);
    this.validate(input);
    const values = {
      name: input.name.trim(),
      configJson: JSON.stringify(input.config),
    };
    if (!id) {
      const rows = await this.database.run((db) =>
        db.execute<Row>(
          db
            .insert(workspaceSavedView)
            .values({
              ...values,
              ownerUserId: userId,
              scope: input.scope,
            })
            .returning(VIEW_COLUMNS),
        ),
      );
      return this.dto(rows[0], actor);
    }
    const current = await this.readEditable(actor, id);
    if (input.scope !== current.scope)
      throw new BadRequestException('视图范围不能原地变更，请另存为新视图');
    if (input.expectedVersion === undefined)
      throw new BadRequestException('缺少视图版本，请刷新后重试');
    const rows = await this.database.run((db) =>
      db.execute<Row>(
        db
          .update(workspaceSavedView)
          .set({
            ...values,
            version: sql`${workspaceSavedView.version} + 1`,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(
            and(
              eq(workspaceSavedView.id, id),
              eq(workspaceSavedView.version, input.expectedVersion),
            ),
          )
          .returning(VIEW_COLUMNS),
      ),
    );
    if (!rows.length)
      throw new ConflictException('视图已被更新，请刷新后再保存');
    return this.dto(rows[0], actor);
  }

  private async readEditable(
    actor: CurrentUserSummary,
    id: string,
  ): Promise<Row> {
    const userId = this.user(actor);
    const rows = await this.database.run((db) =>
      db.execute<Row>(
        db
          .select(VIEW_COLUMNS)
          .from(workspaceSavedView)
          .where(
            and(
              eq(workspaceSavedView.id, id),
              or(
                eq(workspaceSavedView.ownerUserId, userId),
                eq(workspaceSavedView.scope, 'team'),
              ),
            ),
          )
          .limit(1),
      ),
    );
    if (!rows.length) throw new NotFoundException('视图不存在');
    return rows[0];
  }

  async remove(
    actor: CurrentUserSummary,
    id: string,
    version: number,
  ): Promise<{ success: boolean; message: string }> {
    await this.readEditable(actor, id);
    if (!Number.isInteger(version) || version < 1)
      throw new BadRequestException('缺少视图版本，请刷新后重试');
    const rows = await this.database.run((db) =>
      db.execute<{ id: string }>(
        db
          .delete(workspaceSavedView)
          .where(
            and(
              eq(workspaceSavedView.id, id),
              eq(workspaceSavedView.version, version),
            ),
          )
          .returning({ id: workspaceSavedView.id }),
      ),
    );
    if (!rows.length) throw new ConflictException('视图已被更新，请刷新后重试');
    return { success: true, message: '视图已删除' };
  }
}
