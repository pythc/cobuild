import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import type { WorkspaceSavedViewInput } from '../../../shared/workspace-efficiency';
import { RequirementsQueryService } from '../requirements/requirements-query.service';
import { WorkspaceViewsService } from './workspace-views.service';

@Controller('api/workspace/views')
@NeedLogin()
export class WorkspaceViewsController {
  constructor(
    private readonly views: WorkspaceViewsService,
    private readonly requirements: RequirementsQueryService,
  ) {}
  private actor(req: Request) {
    const context = req.userContext;
    if (!context?.userId) throw new UnauthorizedException('请先登录');
    return this.requirements.currentUser({
      userId: context.userId,
      userName: context.userName || '',
      roles: context.roles || [],
      appId: context.appId,
    });
  }
  @Get()
  @Header('Cache-Control', 'no-store, private')
  async list(@Req() req: Request) {
    return this.views.list(await this.actor(req));
  }
  @Post()
  async create(@Req() req: Request, @Body() input: WorkspaceSavedViewInput) {
    return this.views.save(await this.actor(req), input);
  }
  @Put(':id')
  async update(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: WorkspaceSavedViewInput,
  ) {
    return this.views.save(await this.actor(req), input, id);
  }
  @Delete(':id')
  async remove(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('version') version: string,
  ) {
    return this.views.remove(await this.actor(req), id, Number(version));
  }
}
