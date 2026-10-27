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
import { RequirementPlatformRoleService } from '../requirements/requirement-platform-role.service';
import { IterationEfficiencyService } from './iteration-efficiency.service';

@Controller('api/workspace/iterations')
export class IterationEfficiencyController {
  constructor(
    private readonly efficiency: IterationEfficiencyService,
    private readonly roles: RequirementPlatformRoleService,
  ) {}
  @Get(':id/efficiency')
  @NeedLogin()
  @Header('Cache-Control', 'private, no-store')
  async get(@Req() req: Request, @Param('id') id: string) {
    const userId = req.userContext?.userId,
      appId = req.userContext?.appId || '';
    if (!userId || userId === 'anonymous_user_id')
      throw new UnauthorizedException('请先登录');
    if (!/^rec[A-Za-z0-9]{1,80}$/u.test(id))
      throw new BadRequestException('迭代编号无效');
    return this.efficiency.get(id, {
      userId,
      userName: req.userContext.userName || '',
      appId,
      roles: await this.roles.currentRoles(userId, appId),
    });
  }
}
