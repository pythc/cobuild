import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Query,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import type {
  OperationListQuery,
  OperationListResponse,
  OperationsReviewListResponse,
  OperationsAccess,
  OperationProgressResponse,
} from '@shared/api.interface';
import { OperationsAccessService } from './operations-access.service';
import { OperationsService } from './operations.service';

export function operationPage(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new BadRequestException('分页参数无效');
  const parsed: number = Number(value);
  if (
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > max
  )
    throw new BadRequestException('分页参数无效');
  return parsed;
}

@Controller('api/operations')
export class OperationsController {
  constructor(
    private readonly permissions: OperationsAccessService,
    private readonly operations: OperationsService,
  ) {}

  @Get('progress')
  @NeedLogin()
  @Header('Cache-Control', 'no-store, private')
  async progress(
    @Req() req: Request,
    @Query() raw: Record<string, string>,
  ): Promise<OperationProgressResponse> {
    const access = await this.permissions.access(req);
    const response = await this.readRecords(access, { ...raw, scope: 'mine' });
    return {
      ...response,
      items: response.items.map(
        ({
          id,
          requirementId,
          status,
          attempts,
          result,
          errorMessage,
          createdAt,
          finishedAt,
        }) => ({
          id,
          requirementId,
          status,
          attempts,
          result,
          errorMessage,
          createdAt,
          finishedAt,
        }),
      ),
    };
  }

  @Get('records')
  @NeedLogin()
  @Header('Cache-Control', 'no-store, private')
  async records(
    @Req() req: Request,
    @Query() raw: Record<string, string>,
  ): Promise<OperationListResponse> {
    const access = await this.permissions.assertGlobal(req);
    return this.readRecords(access, raw);
  }

  private async readRecords(
    access: OperationsAccess,
    raw: Record<string, string>,
  ): Promise<OperationListResponse> {
    for (const key of [
      'scope',
      'status',
      'operationId',
      'requirementId',
      'requirementCode',
      'pullNumber',
      'since',
      'until',
      'page',
      'pageSize',
    ]) {
      if (raw[key] !== undefined && typeof raw[key] !== 'string')
        throw new BadRequestException('查询参数必须是单个字符串');
    }
    if (raw.scope && !['mine', 'all'].includes(raw.scope))
      throw new BadRequestException('不支持的查看范围');
    if (raw.scope === 'all' && !access.canViewAll)
      throw new ForbiddenException('仅运行管理员可查看全局记录');
    if (
      raw.status &&
      !['all', 'queued', 'running', 'succeeded', 'failed', 'unknown'].includes(
        raw.status,
      )
    )
      throw new BadRequestException('不支持的操作状态');
    if (
      raw.operationId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        raw.operationId,
      )
    )
      throw new BadRequestException('操作编号格式无效');
    if (raw.requirementId && !/^rec[A-Za-z0-9]{1,80}$/u.test(raw.requirementId))
      throw new BadRequestException('请输入需求链接中的记录编号（rec 开头）');
    if (raw.requirementCode && !/^REQ-[0-9]{6,30}$/iu.test(raw.requirementCode))
      throw new BadRequestException('需求编号格式无效');
    if (raw.pullNumber && !/^[1-9][0-9]{0,8}$/u.test(raw.pullNumber))
      throw new BadRequestException('PR 编号格式无效');
    for (const key of ['since', 'until'])
      if (
        raw[key] &&
        (!/^\d{4}-\d{2}-\d{2}T/u.test(raw[key]) ||
          !Number.isFinite(Date.parse(raw[key])))
      )
        throw new BadRequestException('时间范围无效');
    if (raw.since && raw.until && Date.parse(raw.since) > Date.parse(raw.until))
      throw new BadRequestException('开始时间不能晚于结束时间');
    const query: OperationListQuery = {
      scope: raw.scope === 'all' ? 'all' : 'mine',
      status: raw.status as OperationListQuery['status'],
      operationId: raw.operationId,
      requirementId: raw.requirementId,
      requirementCode: raw.requirementCode?.toUpperCase(),
      pullNumber: raw.pullNumber ? Number(raw.pullNumber) : undefined,
      since: raw.since,
      until: raw.until,
      page: operationPage(raw.page, 1, 10_000),
      pageSize: operationPage(raw.pageSize, 25, 100),
    };
    return this.operations.list(access, query);
  }

  @Get('ai-reviews')
  @NeedLogin()
  @Header('Cache-Control', 'no-store, private')
  async reviews(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<OperationsReviewListResponse> {
    await this.permissions.assertGlobal(req);
    return this.operations.reviews(
      operationPage(page, 1, 10_000),
      operationPage(pageSize, 25, 100),
    );
  }
}
