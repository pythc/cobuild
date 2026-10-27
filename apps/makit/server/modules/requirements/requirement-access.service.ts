import { ForbiddenException, Injectable } from '@nestjs/common';
import type {
  CurrentUserSummary,
  RequirementPatch,
  RequirementSummary,
} from '@shared/api.interface';

const PLATFORM_ROLES = new Set(['admin', 'editor', 'viewer']);

/** Business rights never imply administrative access. */
@Injectable()
export class RequirementAccessService {
  roles(actor: CurrentUserSummary): Set<string> {
    return new Set(
      (actor.platformRoleIds || actor.roles || []).filter((role) =>
        PLATFORM_ROLES.has(role),
      ),
    );
  }
  canCollaborate(actor: CurrentUserSummary): boolean {
    return (
      Boolean(actor.miaodaUserId?.trim()) &&
      actor.miaodaUserId !== 'anonymous_user_id'
    );
  }
  decorate(actor: CurrentUserSummary): CurrentUserSummary {
    const rawRoles = actor.platformRoleIds || actor.roles || [];
    const roles = this.roles(actor);
    const allowed = this.canCollaborate(actor);
    return {
      ...actor,
      roles: [...roles],
      platformRoleIds: rawRoles,
      accessLevel: roles.has('admin')
        ? 'admin'
        : roles.has('editor')
          ? 'editor'
          : roles.has('viewer')
            ? 'viewer'
            : 'member',
      capabilities: {
        canCreate: allowed,
        canViewArchive: allowed,
        canPermanentlyDelete: allowed,
        canViewNotifications: allowed,
        canViewOperations:
          allowed &&
          rawRoles.some((role) =>
            ['operations_super_admin', 'operations_viewer'].includes(role),
          ),
        canManageOperationsAdmins:
          allowed && rawRoles.includes('operations_super_admin'),
      },
    };
  }
  isAdmin(actor: CurrentUserSummary): boolean {
    return this.roles(actor).has('admin');
  }
  assertCanCreate(actor: CurrentUserSummary): void {
    if (!this.canCollaborate(actor))
      throw new ForbiddenException('请先登录需求平台');
  }
  assertCanComment(actor: CurrentUserSummary): void {
    this.assertCanCreate(actor);
  }
  assertCanUpdate(
    _requirement: RequirementSummary,
    _patch: RequirementPatch,
    actor: CurrentUserSummary,
  ): void {
    this.assertCanCreate(actor);
  }
  canUpdate(
    _requirement: RequirementSummary,
    actor: CurrentUserSummary,
  ): boolean {
    return this.canCollaborate(actor);
  }
  canArchive(
    _requirement: RequirementSummary,
    actor: CurrentUserSummary,
  ): boolean {
    return this.canCollaborate(actor);
  }
  canComment(actor: CurrentUserSummary): boolean {
    return this.canCollaborate(actor);
  }
  assertCanManageAcceptance(
    requirement: RequirementSummary,
    actor: CurrentUserSummary,
  ): void {
    this.assertCanUpdate(requirement, {}, actor);
  }
  assertCanManageRelations(
    requirement: RequirementSummary,
    actor: CurrentUserSummary,
  ): void {
    this.assertCanUpdate(requirement, {}, actor);
  }
  assertCanManageGroup(
    requirement: RequirementSummary,
    actor: CurrentUserSummary,
  ): void {
    this.assertCanUpdate(requirement, {}, actor);
  }
  assertCanArchive(
    requirement: RequirementSummary,
    actor: CurrentUserSummary,
  ): void {
    this.assertCanUpdate(requirement, {}, actor);
  }
  assertCanRestore(actor: CurrentUserSummary): void {
    this.assertCanCreate(actor);
  }
  assertCanListArchive(actor: CurrentUserSummary): void {
    this.assertCanCreate(actor);
  }
  assertCanPermanentlyDelete(actor: CurrentUserSummary): void {
    this.assertCanCreate(actor);
  }
}
