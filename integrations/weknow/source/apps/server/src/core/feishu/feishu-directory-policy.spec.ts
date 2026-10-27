import {
  assertDirectoryAccess,
  memberStatus,
  safeFeishuAvatar,
} from './feishu-directory-policy';
const active = {
  is_frozen: false,
  is_resigned: false,
  is_exited: false,
  is_activated: true,
};
describe('Feishu member lifecycle policy', () => {
  test('active member with a fresh snapshot can access', () =>
    expect(() =>
      assertDirectoryAccess({
        directoryStatus: 'active',
        directoryCheckedAt: new Date(),
      }),
    ).not.toThrow());
  test.each([
    'unknown',
    'frozen',
    'resigned',
    'exited',
    'unactivated',
    'out_of_scope',
  ])('rejects unavailable state %s', (directoryStatus) =>
    expect(() =>
      assertDirectoryAccess({
        directoryStatus,
        directoryCheckedAt: new Date(),
      }),
    ).toThrow(),
  );
  test('rejects absent verification, stale and impossible future snapshots', () => {
    for (const date of [
      null,
      new Date(Date.now() - 901000),
      new Date(Date.now() + 120000),
    ])
      expect(() =>
        assertDirectoryAccess({
          directoryStatus: 'active',
          directoryCheckedAt: date,
        }),
      ).toThrow();
  });
  test('15-minute outage grace does not modify account state', () =>
    expect(() =>
      assertDirectoryAccess({
        directoryStatus: 'active',
        directoryCheckedAt: new Date(Date.now() - 600000),
      }),
    ).not.toThrow());
  test.each([
    ['is_frozen', 'frozen'],
    ['is_resigned', 'resigned'],
    ['is_exited', 'exited'],
  ])('detects %s', (key, result) =>
    expect(memberStatus({ ...active, [key]: true })).toBe(result),
  );
  test('unactivated and active', () => {
    expect(memberStatus({ ...active, is_activated: false })).toBe(
      'unactivated',
    );
    expect(memberStatus(active)).toBe('active');
  });
  test.each([
    null,
    {},
    { is_frozen: false, is_resigned: false, is_activated: true },
    { ...active, is_frozen: 'false' },
  ])('incomplete upstream state is never treated as active', (status) =>
    expect(() => memberStatus(status)).toThrow(),
  );
  test('avatar URL stays on trusted HTTPS CDN', () => {
    expect(safeFeishuAvatar('https://s1.feishucdn.com/avatar.png')).toContain(
      'feishucdn.com',
    );
    for (const url of [
      'http://s1.feishucdn.com/a',
      'https://s1.feishucdn.com.evil.test/a',
      'https://a@feishucdn.com/a',
      'javascript:alert(1)',
    ])
      expect(safeFeishuAvatar(url)).toBeNull();
  });
});
