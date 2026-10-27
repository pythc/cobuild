import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { LabIdentityController } from './lab-identity.controller';
import {
  IdentityLoginError,
  identityLoginStep,
} from './lab-identity-diagnostics';
import { LAB_ISSUER } from './lab-identity-policy';

describe('identity callback diagnostics', () => {
  afterEach(() => jest.restoreAllMocks());
  function fixture(error?: Error) {
    const complete = jest.fn();
    if (error) complete.mockRejectedValue(error);
    else
      complete.mockResolvedValue({
        authToken: 'private-auth-token',
        redirect: '/home',
      });
    const service: any = {
      issuer: LAB_ISSUER,
      cookieName: () => 'binding',
      complete,
      secure: true,
    };
    const res: any = {};
    for (const name of ['header', 'clearCookie', 'setCookie', 'redirect'])
      res[name] = jest.fn(() => res);
    const controller = new LabIdentityController(service, {
      getCookieExpiresIn: () => new Date(Date.now() + 3600000),
    } as any);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    return { controller, complete, res, warn };
  }
  const query = {
    iss: LAB_ISSUER,
    state: 'private-state',
    code: 'private-code',
  };
  const request: any = { cookies: { binding: 'private-cookie' } };
  test.each([
    ['browser_binding_mismatch', 401, 'failed'],
    ['exchange', 503, 'unavailable'],
    ['session_create', 500, 'unavailable'],
  ])('records only safe reason for %s', async (stage, status, page) => {
    const { controller, res, warn } = fixture(
      new IdentityLoginError(stage as string, status as number),
    );
    await controller.callback(query, request, res);
    expect(res.redirect).toHaveBeenCalledWith('/login?error=' + page, 302);
    expect(res.setCookie).not.toHaveBeenCalled();
    const log = JSON.stringify(warn.mock.calls);
    expect(log).toContain(stage);
    expect(log).toContain('requestId');
    for (const secret of [
      'private-state',
      'private-code',
      'private-cookie',
      'private-auth-token',
    ])
      expect(log).not.toContain(secret);
  });
  test('rejects an invalid issuer before completing login', async () => {
    const { controller, complete, res } = fixture();
    await controller.callback(
      { ...query, iss: 'https://attacker.example' },
      request,
      res,
    );
    expect(complete).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/login?error=failed', 302);
  });
  test('preserves the successful redirect and secure session cookie', async () => {
    const { controller, res, warn } = fixture();
    await controller.callback(query, request, res);
    expect(res.redirect).toHaveBeenCalledWith('/home', 302);
    expect(res.setCookie).toHaveBeenCalledWith(
      'authToken',
      'private-auth-token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });
  test('classifies an unexpected provider exception without retaining its message', async () => {
    await expect(
      identityLoginStep('exchange', async () => {
        throw new Error('private-provider-token');
      }),
    ).rejects.toMatchObject({ stage: 'exchange', status: 500 });
    await expect(
      identityLoginStep('exchange', async () => {
        throw new ServiceUnavailableException();
      }),
    ).rejects.toMatchObject({ stage: 'exchange', status: 503 });
  });
});
