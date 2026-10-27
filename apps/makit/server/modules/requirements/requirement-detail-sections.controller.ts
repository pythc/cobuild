import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import type { RequirementDetailSection } from '../../../shared/workspace-efficiency';
import { RequirementsQueryService } from './requirements-query.service';

@Controller('api/workspace/requirements')
@NeedLogin()
export class RequirementDetailSectionsController {
  constructor(private readonly requirements: RequirementsQueryService) {}
  private identity(req: Request, id: string) {
    if (!/^rec[A-Za-z0-9]{1,80}$/u.test(id))
      throw new BadRequestException('需求编号无效');
    const context = req.userContext;
    if (!context?.userId) throw new UnauthorizedException('请先登录');
    return {
      userId: context.userId,
      userName: context.userName || '',
      roles: context.roles || [],
      appId: context.appId,
    };
  }
  @Get(':recordId/core')
  @Header('Cache-Control', 'no-store, private')
  core(@Req() req: Request, @Param('recordId') id: string) {
    return this.requirements.detailCore(id, this.identity(req, id));
  }
  @Get(':recordId/sections/:section')
  @Header('Cache-Control', 'no-store, private')
  section(
    @Req() req: Request,
    @Param('recordId') id: string,
    @Param('section') section: string,
  ) {
    if (
      !['comments', 'acceptance', 'relations', 'activities'].includes(section)
    )
      throw new BadRequestException('不支持的详情区域');
    return this.requirements.detailSection(
      id,
      this.identity(req, id),
      section as RequirementDetailSection,
    );
  }
}
