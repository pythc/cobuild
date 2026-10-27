import { ServiceUnavailableException } from '@nestjs/common';
import type { PlatformHttpClientService } from '@lark-apaas/fullstack-nestjs-core';
import { RequirementPlatformRoleService } from '../../server/modules/requirements/requirement-platform-role.service';

describe('RequirementPlatformRoleService', () => {
  const authn = (employeeId: string | null = 'employee-user') => ({
    getBatchLarkUserIds: jest.fn().mockResolvedValue([employeeId]),
  });
  const requestContext = {
    run: jest.fn((_: unknown, callback: () => unknown) => callback()),
  };

  it('queries roles inside a reconstructed user and app context', async () => {
    const post = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({ data: { roleList: ['viewer', 'viewer'] } }),
      ),
    });
    const service = new RequirementPlatformRoleService(
      { instance: { post } } as unknown as PlatformHttpClientService,
      authn() as never,
      requestContext as never,
    );

    await expect(
      service.currentRoles('miaoda-user', 'test-app'),
    ).resolves.toEqual(['viewer']);
    expect(post).toHaveBeenCalledWith(
      '/app/test-app/inner/api/v1/permissions/roles',
      { userID: 'miaoda-user' },
      expect.objectContaining({
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        platformAuth: { customClaims: { user_id: 'miaoda-user' } },
      }),
    );
  });

  it('fails closed when the platform role service is unavailable', async () => {
    const post = jest.fn().mockRejectedValue(new Error('upstream unavailable'));
    const service = new RequirementPlatformRoleService(
      { instance: { post } } as unknown as PlatformHttpClientService,
      authn() as never,
      requestContext as never,
    );

    await expect(
      service.currentRoles('miaoda-user', 'test-app'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reconstructs the Feishu employee identity with AuthNPaasService', async () => {
    const authnService = authn();
    const service = new RequirementPlatformRoleService(
      { instance: { post: jest.fn() } } as unknown as PlatformHttpClientService,
      authnService as never,
      requestContext as never,
    );

    await expect(service.employeeId('miaoda-user', 'test-app')).resolves.toBe(
      'employee-user',
    );
    expect(requestContext.run).toHaveBeenCalledWith(
      { appId: 'test-app', userId: 'miaoda-user' },
      expect.any(Function),
    );
    expect(authnService.getBatchLarkUserIds).toHaveBeenCalledWith([
      'miaoda-user',
    ]);
  });

  it('fails closed when the trusted identity service has no mapping', async () => {
    const service = new RequirementPlatformRoleService(
      { instance: { post: jest.fn() } } as unknown as PlatformHttpClientService,
      authn(null) as never,
      requestContext as never,
    );

    await expect(
      service.employeeId('miaoda-user', 'test-app'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
