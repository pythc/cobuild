import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthorizationSDK, NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { MemberMutationData } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import type {
  ForceRoleDTO,
  MutationResult,
  OperationsAccess,
  OperationsRoleMemberInput,
} from '@shared/api.interface';
import {
  OperationsAccessService,
  OPERATIONS_SUPER_ADMIN_ROLE,
  OPERATIONS_VIEWER_ROLE,
} from './operations-access.service';

const MANAGED_ROLE_IDS: readonly string[] = [
  OPERATIONS_SUPER_ADMIN_ROLE,
  OPERATIONS_VIEWER_ROLE,
];

function memberInput(value: unknown): OperationsRoleMemberInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('请选择要授权或撤权的成员');
  }
  const input: Record<string, unknown> = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key: string): boolean => !['userId', 'action'].includes(key),
    ) ||
    typeof input.userId !== 'string' ||
    !/^[0-9]{1,30}$/u.test(input.userId) ||
    (input.action !== 'add' && input.action !== 'remove')
  ) {
    throw new BadRequestException('仅支持为指定平台成员授权或撤权');
  }
  return { userId: input.userId, action: input.action };
}

@Controller('api/operations')
export class OperationsAdminsController {
  private readonly logger: Logger = new Logger(OperationsAdminsController.name);

  constructor(
    private readonly accessService: OperationsAccessService,
    private readonly authorization: AuthorizationSDK,
  ) {}

  @NeedLogin()
  @Header('Cache-Control', 'private, no-store')
  @Get('access')
  access(@Req() req: Request): Promise<OperationsAccess> {
    return this.accessService.access(req);
  }

  @NeedLogin()
  @Header('Cache-Control', 'private, no-store')
  @Get('roles')
  async roles(@Req() req: Request): Promise<ForceRoleDTO[]> {
    await this.accessService.assertManager(req);
    const roles: ForceRoleDTO[] = await this.authorization.roles.list({
      needMember: true,
    });
    const managed: ForceRoleDTO[] = MANAGED_ROLE_IDS.map(
      (id: string): ForceRoleDTO => {
        const role: ForceRoleDTO | undefined = roles.find(
          (candidate: ForceRoleDTO): boolean => candidate.bizID === id,
        );
        if (!role) {
          throw new ServiceUnavailableException('运行管理员角色配置不完整');
        }
        return {
          bizID: role.bizID,
          name: role.name,
          description: role.description,
          roleMembers: role.roleMembers,
        };
      },
    );
    return managed;
  }

  @NeedLogin()
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  @Post('roles/members')
  async changeMember(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<MutationResult> {
    const actor: OperationsAccess = await this.accessService.assertManager(req);
    const input: OperationsRoleMemberInput = memberInput(body);
    const members: MemberMutationData = {
      userList: [{ userID: input.userId }],
    };
    const audit = {
      event: 'operations_admin_membership',
      actorUserId: actor.userId,
      targetUserId: input.userId,
      roleId: OPERATIONS_VIEWER_ROLE,
      action: input.action,
    };
    try {
      // SDK derives the acting user from trusted request context. This endpoint
      // cannot alter the super-admin role, bulk scopes, or other business roles.
      if (input.action === 'add') {
        await this.authorization.members.add(OPERATIONS_VIEWER_ROLE, {
          members,
        });
      } else {
        await this.authorization.members.remove(OPERATIONS_VIEWER_ROLE, {
          members,
        });
      }
      this.logger.log(JSON.stringify({ ...audit, result: 'succeeded' }));
      return { success: true, message: '已修改' };
    } catch (error: unknown) {
      // Do not serialize SDK payloads, headers, or credentials into the audit.
      this.logger.warn(
        JSON.stringify({
          ...audit,
          result: 'failed',
          status: error instanceof HttpException ? error.getStatus() : 500,
        }),
      );
      throw error;
    }
  }
}
