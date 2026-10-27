import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  RequestMethod,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import type { AuthorizationSDK } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import type { ForceRoleDTO } from '@shared/api.interface';
import {
  OperationsAccessService,
  OPERATIONS_SUPER_ADMIN_ROLE,
  OPERATIONS_VIEWER_ROLE,
} from '../../server/modules/operations/operations-access.service';
import { OperationsAdminsController } from '../../server/modules/operations/operations-admins.controller';
import type { RequirementPlatformRoleService } from '../../server/modules/requirements/requirement-platform-role.service';

function request(
  roles: string[] = [],
  userId: string = '1859972341904474',
): Request {
  return {
    userContext: { userId, appId: 'verified-test-app', roles },
  } as unknown as Request;
}

function setup(roles: string[] = []) {
  const currentRoles = jest.fn().mockResolvedValue(roles);
  const access = new OperationsAccessService({
    currentRoles,
  } as unknown as RequirementPlatformRoleService);
  const list = jest.fn().mockResolvedValue([
    {
      bizID: 'admin',
      name: '旧业务管理员',
      roleMembers: { userList: [{ userID: '999' }] },
    },
    {
      bizID: OPERATIONS_VIEWER_ROLE,
      name: '运行管理员',
      roleMembers: { userList: [] },
    },
    {
      bizID: OPERATIONS_SUPER_ADMIN_ROLE,
      name: '高级管理员',
      roleMembers: { userList: [{ userID: '1859972341904474' }] },
    },
  ] satisfies ForceRoleDTO[]);
  const add = jest.fn().mockResolvedValue({});
  const remove = jest.fn().mockResolvedValue({});
  const sdk = {
    roles: { list },
    members: { add, remove },
  } as unknown as AuthorizationSDK;
  return {
    currentRoles,
    access,
    list,
    add,
    remove,
    controller: new OperationsAdminsController(access, sdk),
  };
}

describe('operations permission boundaries', () => {
  it('registers only access, role reading, and the scoped member mutation routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, OperationsAdminsController)).toBe(
      'api/operations',
    );
    for (const [handler, path, method] of [
      ['access', 'access', RequestMethod.GET],
      ['roles', 'roles', RequestMethod.GET],
      ['changeMember', 'roles/members', RequestMethod.POST],
    ] as const) {
      expect(
        Reflect.getMetadata(
          PATH_METADATA,
          OperationsAdminsController.prototype[handler],
        ),
      ).toBe(path);
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          OperationsAdminsController.prototype[handler],
        ),
      ).toBe(method);
      expect(
        Reflect.getMetadata(
          HEADERS_METADATA,
          OperationsAdminsController.prototype[handler],
        ),
      ).toContainEqual({ name: 'Cache-Control', value: 'private, no-store' });
    }
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        OperationsAdminsController.prototype.changeMember,
      ),
    ).toBe(200);
  });
  it.each([
    {
      roles: [],
      role: 'member',
      all: false,
      manage: false,
      notifications: false,
    },
    {
      roles: ['editor'],
      role: 'member',
      all: false,
      manage: false,
      notifications: false,
    },
    {
      roles: ['viewer'],
      role: 'member',
      all: false,
      manage: false,
      notifications: false,
    },
    {
      roles: ['admin'],
      role: 'member',
      all: false,
      manage: false,
      notifications: true,
    },
    {
      roles: [OPERATIONS_VIEWER_ROLE],
      role: 'operations_admin',
      all: true,
      manage: false,
      notifications: true,
    },
    {
      roles: [OPERATIONS_SUPER_ADMIN_ROLE],
      role: 'super_admin',
      all: true,
      manage: true,
      notifications: true,
    },
    {
      roles: [OPERATIONS_VIEWER_ROLE, OPERATIONS_SUPER_ADMIN_ROLE],
      role: 'super_admin',
      all: true,
      manage: true,
      notifications: true,
    },
  ])(
    'maps actual roles $roles without business privilege escalation',
    async ({ roles, role, all, manage, notifications }) => {
      const { access, currentRoles } = setup(roles);
      await expect(access.access(request())).resolves.toEqual({
        userId: '1859972341904474',
        role,
        canViewAll: all,
        canManageAdmins: manage,
        canViewNotifications: notifications,
      });
      expect(currentRoles).toHaveBeenCalledWith(
        '1859972341904474',
        'verified-test-app',
      );
    },
  );

  it('rejects an anonymous request before contacting the platform', async () => {
    const { access, currentRoles } = setup([OPERATIONS_SUPER_ADMIN_ROLE]);
    await expect(access.access(request([], ''))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(currentRoles).not.toHaveBeenCalled();
  });

  it('rejects the platform anonymous-user sentinel', async () => {
    const { access, currentRoles } = setup();
    await expect(
      access.access(request([], 'anonymous_user_id')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(currentRoles).not.toHaveBeenCalled();
  });

  it('ignores stale session super-admin roles and denies after revocation', async () => {
    const { access, currentRoles } = setup([OPERATIONS_SUPER_ADMIN_ROLE]);
    const req: Request = request([OPERATIONS_SUPER_ADMIN_ROLE]);
    await expect(access.assertManager(req)).resolves.toMatchObject({
      canManageAdmins: true,
    });
    currentRoles.mockResolvedValueOnce([]);
    await expect(access.assertManager(req)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(currentRoles).toHaveBeenCalledTimes(2);
  });

  it('fails closed when authorization cannot be refreshed', async () => {
    const { access, currentRoles } = setup();
    currentRoles.mockRejectedValue(new ServiceUnavailableException());
    await expect(
      access.assertGlobal(request([OPERATIONS_SUPER_ADMIN_ROLE])),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([
    { roles: [] },
    { roles: ['admin'] },
    { roles: ['editor'] },
    { roles: [OPERATIONS_VIEWER_ROLE] },
  ])(
    'does not allow $roles to list or modify administrators',
    async ({ roles }) => {
      const { controller, list, add, remove } = setup(roles);
      await expect(controller.roles(request())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        controller.changeMember(request(), { userId: '223344', action: 'add' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(list).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it('returns only the two managed roles and retains the original members', async () => {
    const { controller, list } = setup([OPERATIONS_SUPER_ADMIN_ROLE]);
    const result: ForceRoleDTO[] = await controller.roles(request());
    expect(result.map((role: ForceRoleDTO) => role.bizID)).toEqual([
      OPERATIONS_SUPER_ADMIN_ROLE,
      OPERATIONS_VIEWER_ROLE,
    ]);
    expect(result[0].roleMembers?.userList).toEqual([
      { userID: '1859972341904474' },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ needMember: true });
  });

  it('does not silently accept missing platform role configuration', async () => {
    const { controller, list } = setup([OPERATIONS_SUPER_ADMIN_ROLE]);
    list.mockResolvedValue([]);
    await expect(controller.roles(request())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each(['add', 'remove'] as const)(
    'uses SDK single-user %s without impersonation or clear-all',
    async (action) => {
      const { controller, add, remove } = setup([OPERATIONS_SUPER_ADMIN_ROLE]);
      await expect(
        controller.changeMember(request(), {
          userId: '22334455667788',
          action,
        }),
      ).resolves.toEqual({ success: true, message: '已修改' });
      const called = action === 'add' ? add : remove;
      const untouched = action === 'add' ? remove : add;
      expect(called).toHaveBeenCalledWith(OPERATIONS_VIEWER_ROLE, {
        members: { userList: [{ userID: '22334455667788' }] },
      });
      expect(untouched).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    [],
    {},
    { userId: 223344, action: 'add' },
    { userId: 'ou_unsupported_identity', action: 'add' },
    { userId: '223344', action: 'clear' },
    { userId: '223344', action: 'add', role: OPERATIONS_SUPER_ADMIN_ROLE },
    { userId: '223344', action: 'add', userID: '99999' },
    { userId: '223344', action: 'add', actorUserId: '99999' },
    { userId: '223344', action: 'add', isContainsAdmin: true },
    { userId: '223344', action: 'add', members: { allEmployees: true } },
    { userId: '223344', action: 'add', departmentList: [{ id: '1' }] },
    { userId: '223344', action: 'add', groupChatList: [{ chatID: '1' }] },
  ])(
    'rejects invalid or over-scoped member input %#',
    async (input: unknown) => {
      const { controller, add, remove } = setup([OPERATIONS_SUPER_ADMIN_ROLE]);
      await expect(
        controller.changeMember(request(), input),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(add).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it('propagates an SDK failure rather than reporting a successful grant', async () => {
    const { controller, add } = setup([OPERATIONS_SUPER_ADMIN_ROLE]);
    add.mockRejectedValue(new ForbiddenException('role mutation denied'));
    await expect(
      controller.changeMember(request(), { userId: '223344', action: 'add' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
