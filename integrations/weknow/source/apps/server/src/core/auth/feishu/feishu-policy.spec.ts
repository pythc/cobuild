import {
  safeReturnPath,
  identityAllowed,
  equalSecret,
  hashState,
} from './feishu-policy';
describe('110lab Feishu authorization boundary', () => {
  test.each([
    '/a/..//evil.example',
    '/%2e//evil.example',
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    '/a\nb',
    '/login',
    '/api/auth/feishu/callback',
    null,
    [],
    '/\u202eb',
  ])(
    'rejects external, malformed or authentication return paths: %p',
    (value) => expect(safeReturnPath(value)).toBe('/home'),
  );
  test('preserves document identity, query and hash after login', () =>
    expect(safeReturnPath('/s/project/p/design?mode=read#api')).toBe(
      '/s/project/p/design?mode=read#api',
    ));
  test('requires configured organization and a stable Feishu user identity', () => {
    expect(
      identityAllowed({ tenant_key: 'org', open_id: 'ou_test_user' }, 'org'),
    ).toBe(true);
    expect(
      identityAllowed(
        { tenant_key: 'outside', open_id: 'ou_test_user' },
        'org',
      ),
    ).toBe(false);
    expect(identityAllowed({ tenant_key: 'org', open_id: '' }, 'org')).toBe(
      false,
    );
    expect(
      identityAllowed({ tenant_key: '', open_id: 'ou_test_user' }, ''),
    ).toBe(false);
  });
  test('browser binding comparison handles empty and wrong-sized inputs', () => {
    expect(equalSecret('correct', 'correct')).toBe(true);
    expect(equalSecret(undefined, 'correct')).toBe(false);
    expect(equalSecret('wrong', 'correct')).toBe(false);
  });
  test('flow store keys do not contain the raw state', () => {
    expect(hashState('raw-state')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashState('raw-state')).not.toContain('raw-state');
  });
});
