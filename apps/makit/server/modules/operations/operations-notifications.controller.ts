import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import type { WorkflowNotificationListResponse } from '@shared/api.interface';
import { OperationsAccessService } from './operations-access.service';
import { OperationsNotificationsService } from './operations-notifications.service';

@Controller('api/operations/workflow-notifications')
export class OperationsNotificationsController {
  constructor(
    private readonly access: OperationsAccessService,
    private readonly notifications: OperationsNotificationsService,
  ) {}

  @NeedLogin()
  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(
    @Req() req: Request,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
  ): Promise<WorkflowNotificationListResponse> {
    await this.access.assertGlobal(req);
    const page: number = rawPage ? Number(rawPage) : 1;
    const pageSize: number = rawPageSize ? Number(rawPageSize) : 25;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1
    ) {
      throw new BadRequestException('分页参数无效');
    }
    return this.notifications.list(page, Math.min(pageSize, 100));
  }
}
