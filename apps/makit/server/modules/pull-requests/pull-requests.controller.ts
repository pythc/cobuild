import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import type {
  PullRequestDetailResponse,
  PullRequestRefreshResult,
  PullRequestReviewerUpdateInput,
  PullRequestReviewerUpdateResult,
  PullRequestSummary,
  PullRequestWorkspaceResponse,
} from '@shared/api.interface';
import { PullRequestsService } from './pull-requests.service';

interface RequestIdentity {
  userId: string;
  userName: string;
  roles: string[];
}

@Controller('api/pull-requests')
export class PullRequestsController {
  constructor(private readonly pullRequests: PullRequestsService) {}

  private identity(req: Request): RequestIdentity {
    const userId: string = req.userContext?.userId || '';
    if (!userId) throw new UnauthorizedException('请先登录');
    return {
      userId,
      userName: req.userContext?.userName || '当前用户',
      roles: req.userContext?.roles || [],
    };
  }

  @NeedLogin()
  @Get()
  async workspace(@Req() req: Request): Promise<PullRequestWorkspaceResponse> {
    return this.pullRequests.workspace(this.identity(req));
  }

  @NeedLogin()
  @Post('refresh')
  async refresh(@Req() req: Request): Promise<PullRequestRefreshResult> {
    return this.pullRequests.refresh(this.identity(req));
  }

  @NeedLogin()
  @Post(':pullNumber/refresh')
  async refreshPullRequest(@Req() req: Request, @Param('pullNumber', ParseIntPipe) pullNumber: number): Promise<PullRequestRefreshResult> {
    return this.pullRequests.refreshPullRequest(pullNumber, this.identity(req));
  }

  @NeedLogin()
  @Get('requirements/:recordId')
  async forRequirement(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ): Promise<PullRequestSummary[]> {
    return this.pullRequests.forRequirement(recordId, this.identity(req));
  }

  @NeedLogin()
  @Get(':pullNumber')
  async detail(
    @Req() req: Request,
    @Param('pullNumber', ParseIntPipe) pullNumber: number,
  ): Promise<PullRequestDetailResponse> {
    return this.pullRequests.detail(pullNumber, this.identity(req));
  }

  @NeedLogin()
  @Patch(':pullNumber/reviewers')
  async updateReviewers(
    @Req() req: Request,
    @Param('pullNumber', ParseIntPipe) pullNumber: number,
    @Body() input?: PullRequestReviewerUpdateInput,
  ): Promise<PullRequestReviewerUpdateResult> {
    const identity: RequestIdentity = this.identity(req);
    if (!Array.isArray(input?.reviewerLogins)) {
      throw new BadRequestException('reviewerLogins 必须是数组');
    }
    if (
      input.reviewerLogins.some(
        (login: unknown): boolean => typeof login !== 'string',
      )
    ) {
      throw new BadRequestException('GitHub 账号格式不正确');
    }
    if (
      input.reviewerBindings !== undefined &&
      (!Array.isArray(input.reviewerBindings) ||
        input.reviewerBindings.some(
          (binding): boolean =>
            !binding ||
            typeof binding.login !== 'string' ||
            typeof binding.feishuEmployeeId !== 'string',
        ))
    ) {
      throw new BadRequestException('飞书成员绑定格式不正确');
    }
    return this.pullRequests.updateReviewers(
      pullNumber,
      input.reviewerLogins,
      identity,
      input.reviewerBindings || [],
    );
  }
}
