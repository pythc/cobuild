import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import type { RequirementBatchPreviewInput } from '@shared/requirement-batch';
import { RequirementBatchService } from './requirement-batch.service';
import { RequirementsQueryService } from './requirements-query.service';
@Controller('api/workspace/requirement-batches')
export class RequirementBatchController {
  constructor(
    private readonly batches: RequirementBatchService,
    private readonly query: RequirementsQueryService,
  ) {}
  private actor(req: Request) {
    const context = req.userContext;
    if (!context?.userId) throw new UnauthorizedException('请先登录');
    return this.query.currentUser({
      userId: context.userId,
      userName: '',
      appId: context.appId,
    });
  }
  @NeedLogin()
  @Post('preview')
  async preview(
    @Req() req: Request,
    @Body() input: RequirementBatchPreviewInput,
  ) {
    return this.batches.preview(input, await this.actor(req));
  }
  @NeedLogin()
  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    return this.batches.get(id, await this.actor(req));
  }
  @NeedLogin()
  @Post(':id/execute')
  async execute(@Req() req: Request, @Param('id') id: string) {
    return this.batches.execute(id, await this.actor(req));
  }
  @NeedLogin()
  @Post(':id/retry-preview')
  async retry(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() input: { clientMutationId: string },
  ) {
    return this.batches.retryPreview(
      id,
      await this.actor(req),
      input?.clientMutationId,
    );
  }
}
