import { NativeAuthMiddleware } from './native-auth.middleware';
describe('Feishu-only API surface', () => {
  const middleware = new NativeAuthMiddleware();
  test.each([
    '/api/auth/login',
    '/api/auth/setup',
    '/api/auth/forgot-password',
    '/api/auth/password-reset',
    '/api/workspace/invites/accept',
    '/api/workspaces/invites/create',
    '/api/sso/login',
    '/api/billing',
    '/api/auth/%6cogin',
  ])('rejects legacy authentication or paid endpoint %s', (url) => {
    const next = jest.fn();
    const response: any = { setHeader: jest.fn(), end: jest.fn() };
    middleware.use({ url }, response, next);
    expect(response.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
  test('uses the original path when an adapter mounts middleware on a stripped URL',()=>{
    const next=jest.fn();const response:any={setHeader:jest.fn(),end:jest.fn()};
    middleware.use({url:'/',originalUrl:'/api/workspace/invites/create'},response,next);
    expect(response.statusCode).toBe(404);expect(next).not.toHaveBeenCalled();
  });
  test.each([
    '/api/auth/feishu/status',
    '/api/auth/feishu/login',
    '/api/auth/feishu/callback',
    '/api/auth/logout',
    '/api/pages/info',
    '/api/pages/export',
  ])('allows current community route %s', (url) => {
    const next = jest.fn();
    middleware.use({ url }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
