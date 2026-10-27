import { DevelopmentOverdueService } from './development-overdue.service';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Post,
  Optional,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { RequirementPlatformRoleService } from '../requirements/requirement-platform-role.service';
import {
  NotificationDeliveryService,
  type DeliveryResult,
  type ClaimedDelivery,
} from './notification-delivery.service';
import { NotificationRetryService } from './notification-retry.service';
import { verifyWorkerToken } from './notification-delivery.model';
import { WorkflowSourceService } from './workflow-source.service';

@Controller('api/operations/notification-deliveries')
export class NotificationDeliveryController {
  constructor(
    private readonly deliveries: NotificationDeliveryService,
    private readonly retries: NotificationRetryService,
    private readonly roles: RequirementPlatformRoleService,
  ) {}

  private async authorize(req: Request, _write = false): Promise<string> {
    const userId: string = req.userContext?.userId || '';
    if (!userId || userId === 'anonymous_user_id')
      throw new UnauthorizedException('请先登录');
    const roles: string[] = await this.roles.currentRoles(
      userId,
      req.userContext.appId,
    );
    if (
      !roles.includes('operations_super_admin') &&
      !roles.includes('operations_viewer')
    )
      throw new ForbiddenException('没有通知运行管理权限');
    return userId;
  }

  @NeedLogin()
  @Header('Cache-Control', 'private, no-store')
  @Get()
  async list(
    @Req() req: Request,
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      operationId?: string;
      requirementId?: string;
    },
  ): Promise<Record<string, unknown>> {
    await this.authorize(req);
    return this.deliveries.list({
      ...query,
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 30,
    });
  }

  @NeedLogin()
  @Header('Cache-Control', 'private, no-store')
  @Post('retry-preview')
  async preview(
    @Req() req: Request,
    @Body() body: { ids?: unknown },
  ): Promise<Record<string, unknown>> {
    return this.retries.preview(await this.authorize(req, true), body?.ids);
  }

  @NeedLogin()
  @Header('Cache-Control', 'private, no-store')
  @Post('retry')
  async retry(
    @Req() req: Request,
    @Body() body: { token?: string },
  ): Promise<{ acceptedCount: number }> {
    return this.retries.confirm(
      await this.authorize(req, true),
      body?.token || '',
    );
  }
}

@Controller('openapi/workflow-deliveries')
export class WorkflowDeliveryController {
  constructor(
    private readonly deliveries: NotificationDeliveryService,
    private readonly source: WorkflowSourceService,
    @Optional() private readonly overdue?: DevelopmentOverdueService,
  ) {}

  @Header('Cache-Control', 'private, no-store')
  @Post('reconcile')
  @HttpCode(200)
  async reconcile(
    @Req() req: Request,
    @Body() body: Parameters<WorkflowSourceService['reconcile']>[0],
  ) {
    verifyWorkerToken(req.headers['x-workflow-worker-token']);
    return this.source.reconcile(body);
  }

  @Header('Cache-Control', 'private, no-store')
  @Post('ingest')
  @HttpCode(200)
  async ingest(
    @Req() req: Request,
    @Body() body: Parameters<NotificationDeliveryService['ingestWorkflow']>[0],
  ) {
    verifyWorkerToken(req.headers['x-workflow-worker-token']);
    return this.deliveries.ingestWorkflow(body);
  }

  @Header('Cache-Control', 'private, no-store')
  @Post('claim')
  @HttpCode(200)
  async claim(@Req() req: Request): Promise<{ items: ClaimedDelivery[] }> {
    verifyWorkerToken(req.headers['x-workflow-worker-token']);
    await this.overdue?.scan();
    return { items: await this.deliveries.claim('managed_bot', [], 1) };
  }

  @Header('Cache-Control', 'private, no-store')
  @Post('result')
  @HttpCode(200)
  async result(
    @Req() req: Request,
    @Body() body: DeliveryResult,
  ): Promise<{ accepted: boolean }> {
    verifyWorkerToken(req.headers['x-workflow-worker-token']);
    if (
      !body ||
      !/^[0-9a-f-]{36}$/iu.test(body.id || '') ||
      !/^[0-9a-f-]{36}$/iu.test(body.leaseToken || '')
    )
      throw new BadRequestException('投递回执格式无效');
    return this.deliveries.result(body);
  }
}
