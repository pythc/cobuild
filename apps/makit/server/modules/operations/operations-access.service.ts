import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { OperationsAccess } from '@shared/api.interface';
import { RequirementPlatformRoleService } from '../requirements/requirement-platform-role.service';

// Real Miaoda roles, independently created and verified before implementation.
export const OPERATIONS_SUPER_ADMIN_ROLE = 'operations_super_admin';
export const OPERATIONS_VIEWER_ROLE = 'operations_viewer';

@Injectable()
export class OperationsAccessService {
  constructor(private readonly platformRoles: RequirementPlatformRoleService) {}

  async access(req: Request): Promise<OperationsAccess> {
    const userId: string = req.userContext?.userId?.trim() || '';
    if (!userId || userId === 'anonymous_user_id') {
      throw new UnauthorizedException('请先登录');
    }

    // Never trust a cached session role or a client-supplied actor. Revocation
    // takes effect on the next request, including member-management writes.
    const roles: string[] = await this.platformRoles.currentRoles(
      userId,
      req.userContext.appId,
    );
    const canManageAdmins: boolean = roles.includes(
      OPERATIONS_SUPER_ADMIN_ROLE,
    );
    const canViewAll: boolean =
      canManageAdmins || roles.includes(OPERATIONS_VIEWER_ROLE);
    return {
      userId,
      role: canManageAdmins
        ? 'super_admin'
        : canViewAll
          ? 'operations_admin'
          : 'member',
      canViewAll,
      canManageAdmins,
      // Existing business administrators retain their notification view only.
      canViewNotifications: canViewAll || roles.includes('admin'),
    };
  }

  async assertGlobal(req: Request): Promise<OperationsAccess> {
    const access: OperationsAccess = await this.access(req);
    if (!access.canViewAll) {
      throw new ForbiddenException('仅运行管理员可查看全部运行记录');
    }
    return access;
  }

  async assertManager(req: Request): Promise<OperationsAccess> {
    const access: OperationsAccess = await this.access(req);
    if (!access.canManageAdmins) {
      throw new ForbiddenException('仅高级管理员可管理运行管理员');
    }
    return access;
  }
}
