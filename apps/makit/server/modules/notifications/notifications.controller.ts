import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import type {
  NotificationDeliveryListResponse,
  NotificationDeliveryStatus,
} from '@shared/api.interface';
import { NotificationsService } from './notifications.service';
import { RequirementsQueryService } from '../requirements/requirements-query.service';
import { RequirementAccessService } from '../requirements/requirement-access.service';
import { RequirementPlatformRoleService } from '../requirements/requirement-platform-role.service';
import { NotificationsReadService } from './notifications-read.service';
import {
  OPERATIONS_SUPER_ADMIN_ROLE,
  OPERATIONS_VIEWER_ROLE,
} from '../operations/operations-access.service';

const DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'retrying',
  'failed',
  'delivered',
  'suppressed',
]);

@Controller('api/notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly requirements: RequirementsQueryService,
    private readonly access: RequirementAccessService,
    private readonly platformRoles: RequirementPlatformRoleService,
    private readonly operationsNotifications: NotificationsReadService,
  ) {}

  @NeedLogin()
  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(
    @Req() req: Request,
    @Query('status') rawStatus?: string,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
  ): Promise<NotificationDeliveryListResponse> {
    if (
      !req.userContext?.userId ||
      req.userContext.userId === 'anonymous_user_id'
    ) {
      throw new UnauthorizedException('请先登录');
    }
    const status: NotificationDeliveryStatus | undefined = rawStatus
      ? DELIVERY_STATUSES.has(rawStatus)
        ? (rawStatus as NotificationDeliveryStatus)
        : undefined
      : undefined;
    if (rawStatus && !status) {
      throw new BadRequestException('不支持的通知状态');
    }
    const page: number = Math.max(1, Math.trunc(Number(rawPage) || 1));
    const pageSize: number = Math.min(
      100,
      Math.max(1, Math.trunc(Number(rawPageSize) || 25)),
    );
    if (
      !Number.isSafeInteger(page) ||
      !Number.isSafeInteger(pageSize) ||
      !Number.isSafeInteger((page - 1) * pageSize)
    ) {
      throw new BadRequestException('分页参数无效');
    }
    return this.operationsNotifications.list(status, page, pageSize);
  }
}
