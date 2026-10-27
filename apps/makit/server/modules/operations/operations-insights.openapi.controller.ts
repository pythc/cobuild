import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { OperationsAccessService } from './operations-access.service';
import { OperationsInsightsService } from './operations-insights.service';
import { OperationsSettingsService } from './operations-settings.service';
import { plainObject } from './operations-insights.model';
import { operationPage } from './operations.controller';

@Controller('api/operations')
@NeedLogin()
export class OperationsInsightsController {
  constructor(
    private readonly access: OperationsAccessService,
    private readonly insights: OperationsInsightsService,
    private readonly settings: OperationsSettingsService,
  ) {}
  @Get('executions')
  @Header('Cache-Control', 'private, no-store')
  async executions(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('days') days?: string,
    @Query('requirementId') requirementId?: string,
  ) {
    await this.access.assertGlobal(req);
    if (
      requirementId !== undefined &&
      (typeof requirementId !== 'string' ||
        !/^rec[A-Za-z0-9]{1,80}$/u.test(requirementId))
    )
      throw new BadRequestException('需求记录编号无效');
    return this.insights.executions(
      operationPage(page, 1, 10000),
      operationPage(days, 7, 90),
      requirementId,
    );
  }
  @Post('executions/:id/feedback')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  async feedback(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.access.assertGlobal(req),
      input = plainObject(body);
    if (
      !/^[a-f0-9-]{36}$/iu.test(id) ||
      Object.keys(input).some((key) => !['feedback', 'reason'].includes(key)) ||
      !['adopted', 'ignored'].includes(String(input.feedback)) ||
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 2 ||
      input.reason.length > 1000
    )
      throw new BadRequestException('请选择采纳或忽略，并说明原因');
    await this.insights.feedback(
      id,
      actor.userId,
      input.feedback as 'adopted' | 'ignored',
      input.reason.trim(),
    );
    return { success: true, message: '已修改' };
  }
  @Get('settings')
  @Header('Cache-Control', 'private, no-store')
  async getSettings(@Req() req: Request) {
    await this.access.assertGlobal(req);
    return this.settings.get();
  }
  @Post('settings')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  async save(@Req() req: Request, @Body() body: unknown) {
    const actor = await this.access.assertGlobal(req),
      input = plainObject(body);
    if (
      Object.keys(input).some(
        (key) => !['settings', 'previewToken'].includes(key),
      )
    )
      throw new BadRequestException('配置参数无效');
    return this.insights.saveSettings(input.settings, actor.userId);
  }
}
