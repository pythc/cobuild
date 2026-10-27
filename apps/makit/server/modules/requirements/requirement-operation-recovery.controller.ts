import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import { RequirementsQueryService } from './requirements-query.service';
import { RequirementPlatformRoleService } from './requirement-platform-role.service';
import { currentPatchValues } from '@shared/requirement-operation';
import type { RequirementUpdateInput } from '@shared/api.interface';

interface RecoveryRow extends Record<string, unknown> {
  id: string;
  requirement_id: string;
  status: string;
  execution_stage: string;
  input_json: string;
  _updated_at: string;
}
@Controller('api/operations/recovery')
export class RequirementOperationRecoveryController {
  constructor(
    private readonly database: ServiceRoleDatabaseExecutor,
    private readonly query: RequirementsQueryService,
    private readonly roles: RequirementPlatformRoleService,
  ) {}
  private async actor(req: Request) {
    const identity = req.userContext;
    if (!identity?.userId || identity.userId === 'anonymous_user_id')
      throw new UnauthorizedException('请先登录');
    if (
      !(await this.roles.currentRoles(identity.userId, identity.appId)).some(
        (role) =>
          ['operations_super_admin', 'operations_viewer'].includes(role),
      )
    )
      throw new ForbiddenException('仅管理员可确认恢复动作');
    return this.query.currentUser({
      userId: identity.userId,
      userName: '',
      appId: identity.appId,
    });
  }
  private async evidence(req: Request, id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        id,
      )
    )
      throw new BadRequestException('操作编号无效');
    const actor = await this.actor(req);
    const row = (
      await this.database.run((db) =>
        db.execute<RecoveryRow>(
          sql`SELECT id,requirement_id,status,execution_stage,input_json,_updated_at FROM requirement_update_job WHERE id=${id}::uuid`,
        ),
      )
    )[0];
    if (
      !row ||
      row.status !== 'unknown' ||
      row.execution_stage === 'reviewed_unknown'
    )
      throw new ConflictException('该操作无需解除阻塞，请刷新结果');
    const latest = await this.query.requirementByIdAs(
      row.requirement_id,
      actor,
    );
    const input: RequirementUpdateInput = JSON.parse(row.input_json).input;
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          actor: actor.miaodaUserId,
          id,
          rowVersion: row._updated_at,
          latestVersion: latest.updatedAt,
          values: currentPatchValues(latest, input.patch),
        }),
      )
      .digest('hex');
    return { actor, row, digest, latest };
  }
  @NeedLogin()
  @Get(':id/preview')
  @Header('Cache-Control', 'private, no-store')
  async preview(@Req() req: Request, @Param('id') id: string) {
    const { row, digest, latest } = await this.evidence(req, id);
    return {
      operationId: id,
      requirementId: row.requirement_id,
      code: latest.code,
      title: latest.title,
      status: latest.status,
      digest,
      warning:
        '仅解除后续修改的排队阻塞。原操作仍记为结果待核实；不会重新写入、触发评审或补发通知。请先核对需求当前值和飞书审计。',
    };
  }
  @NeedLogin()
  @Post(':id/acknowledge')
  @Header('Cache-Control', 'private, no-store')
  async acknowledge(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { digest: string; reason: string; confirmed: boolean },
  ) {
    if (
      body?.confirmed !== true ||
      typeof body.reason !== 'string' ||
      body.reason.trim().length < 5 ||
      body.reason.length > 1000
    )
      throw new BadRequestException('请填写核实依据并确认解除阻塞');
    const { actor, row, digest } = await this.evidence(req, id);
    if (digest !== body.digest)
      throw new ConflictException('记录已变化，请重新核对');
    const updated = await this.database.run((db) =>
      db.execute<{
        id: string;
      }>(sql`UPDATE requirement_update_job SET execution_stage='reviewed_unknown',
      remote_receipt_json=(COALESCE(remote_receipt_json::jsonb,'{}'::jsonb)||${JSON.stringify({ manualResolution: { actorUserId: actor.miaodaUserId, reason: body.reason.trim(), at: new Date().toISOString(), kind: 'unblock_without_replay' } })}::jsonb)::text,
      _updated_at=CURRENT_TIMESTAMP WHERE id=${id}::uuid AND status='unknown' AND execution_stage='reconcile' AND _updated_at=${row._updated_at}::timestamptz RETURNING id`),
    );
    if (!updated.length) throw new ConflictException('记录已变化，请重新核对');
    return { success: true, message: '已解除后续修改阻塞，原结果仍保留待核实' };
  }
  @NeedLogin()
  @Post(':id/consumers/retry')
  @Header('Cache-Control', 'private, no-store')
  async retryConsumers(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { consumer: string; confirmed: boolean },
  ) {
    const actor = await this.actor(req);
    if (
      !/^[0-9a-f-]{36}$/iu.test(id) ||
      body?.confirmed !== true ||
      !['history', 'review', 'notification', 'cache'].includes(body.consumer)
    )
      throw new BadRequestException('恢复操作无效');
    // Only terminal, confirmed-failed consumers. Unknown history and already
    // successful effects are intentionally never re-enqueued here.
    const rows = await this.database.run(async (db) => {
      const changed = await db.execute<{
        id: string;
      }>(sql`UPDATE requirement_operation_outbox SET status='pending',attempts=0,
      available_at=CURRENT_TIMESTAMP,error_code=NULL,finished_at=NULL,_updated_at=CURRENT_TIMESTAMP
      WHERE operation_id=${id}::uuid AND consumer=${body.consumer} AND status='failed'
      AND EXISTS(SELECT 1 FROM requirement_update_job j WHERE j.id=${id}::uuid AND j.status='succeeded') RETURNING id`);
      if (changed.length)
        await db.execute(sql`UPDATE requirement_update_job SET remote_receipt_json=jsonb_set(COALESCE(remote_receipt_json::jsonb,'{}'::jsonb),'{consumerRetryAudit}',
        COALESCE(remote_receipt_json::jsonb->'consumerRetryAudit','[]'::jsonb)||${JSON.stringify([{ actorUserId: actor.miaodaUserId, consumer: body.consumer, at: new Date().toISOString() }])}::jsonb)::text WHERE id=${id}::uuid`);
      return changed;
    });
    if (!rows.length) throw new ConflictException('该环节无需重试，请刷新结果');
    return { success: true, message: '已安排恢复该环节' };
  }
}
