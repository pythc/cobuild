import { RequirementAccessService } from '../../server/modules/requirements/requirement-access.service';
import type {
  CurrentUserSummary,
  RequirementSummary,
} from '@shared/api.interface';
const service = new RequirementAccessService();
const requirement = {
  id: 'recTest',
  status: '开发中',
  handlers: [],
} as unknown as RequirementSummary;
const actor = (roles: string[], id = 'member'): CurrentUserSummary => ({
  miaodaUserId: id,
  name: '测试',
  openId: 'ou_test',
  employeeId: 'test',
  platformRoleIds: roles,
});
describe('authenticated business permissions', () => {
  it.each(
    [[], ['viewer'], ['editor'], ['admin'], ['operations_viewer']].map(
      (roles) => [roles],
    ),
  )('allows business collaboration for %j without role elevation', (roles) => {
    const user = service.decorate(actor(roles));
    expect(service.canUpdate(requirement, user)).toBe(true);
    expect(service.canArchive(requirement, user)).toBe(true);
    for (const check of [
      'assertCanCreate',
      'assertCanComment',
      'assertCanRestore',
      'assertCanListArchive',
      'assertCanPermanentlyDelete',
    ] as const)
      expect(() => service[check](user)).not.toThrow();
    expect(user.capabilities).toEqual(
      expect.objectContaining({
        canCreate: true,
        canViewArchive: true,
        canPermanentlyDelete: true,
        canViewNotifications: true,
      }),
    );
    expect(user.platformRoleIds).toEqual(roles);
    expect(user.capabilities?.canManageOperationsAdmins).toBe(false);
    expect(user.capabilities?.canViewOperations).toBe(
      roles.includes('operations_viewer'),
    );
  });
  it.each(['', ' ', 'anonymous_user_id'])(
    'rejects unauthenticated id %j even with forged admin roles',
    (id) => {
      const user = actor(['admin', 'operations_super_admin'], id);
      expect(service.canUpdate(requirement, user)).toBe(false);
      expect(service.decorate(user).capabilities?.canViewOperations).toBe(
        false,
      );
      expect(() => service.assertCanPermanentlyDelete(user)).toThrow(
        '请先登录',
      );
    },
  );
  it('only the verified super admin role exposes administrator assignment', () => {
    expect(
      service.decorate(actor(['operations_super_admin'])).capabilities
        ?.canManageOperationsAdmins,
    ).toBe(true);
    expect(
      service.decorate(actor(['unknown_admin'])).capabilities
        ?.canViewOperations,
    ).toBe(false);
  });
});
