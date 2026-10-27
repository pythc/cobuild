import { FeishuDirectoryProvider } from './feishu-directory-provider';
const state = {
  is_frozen: false,
  is_resigned: false,
  is_exited: false,
  is_activated: true,
};
const visibility = () => ({
  users: [{ open_id: 'ou_a' }, { open_id: 'ou_b' }],
  invisible_users: [],
  departments: [],
  invisible_departments: [],
  groups: [],
  invisible_groups: [],
  is_visible_to_all: 0,
  has_more_users: 0,
});
describe('authoritative Feishu member snapshot', () => {
  let view: any;
  let api: any;
  let provider: FeishuDirectoryProvider;
  let users: any;
  beforeEach(() => {
    view = visibility();
    users = {
      ou_a: {
        open_id: 'ou_a',
        name: '成员甲',
        status: state,
        avatar: { avatar_72: 'https://s1.feishucdn.com/a' },
      },
      ou_b: { open_id: 'ou_b', name: '成员乙', status: state },
    };
    api = {
      appId: 'app',
      call: jest.fn(async (path: string) =>
        path.includes('visibility')
          ? view
          : path.includes('scopes')
            ? { department_ids: ['0'], has_more: false }
            : { user: users[path.split('/').pop()] },
      ),
      pages: jest.fn(async () => []),
    };
    provider = new FeishuDirectoryProvider(api);
  });
  test('syncs names and actual avatars using app-scoped open IDs', async () => {
    const s = await provider.snapshot();
    expect(s.members).toHaveLength(2);
    expect(s.members[0]).toMatchObject({
      name: '成员甲',
      avatarUrl: 'https://s1.feishucdn.com/a',
      status: 'active',
    });
    expect(api.call).toHaveBeenCalledWith('/contact/v3/users/ou_a', {
      user_id_type: 'open_id',
      department_id_type: 'department_id',
    });
  });
  test('explicit exclusion wins even when a member is included', async () => {
    view.invisible_users = [{ open_id: 'ou_a' }];
    expect((await provider.snapshot()).members.map((m) => m.subject)).toEqual([
      'ou_b',
    ]);
  });
  test('missing status permissions fail the entire snapshot', async () => {
    users.ou_b.status = undefined;
    await expect(provider.snapshot()).rejects.toThrow();
  });
  test('invalid member response does not publish a partial list', async () => {
    users.ou_b = { open_id: 'other', name: 'wrong', status: state };
    await expect(provider.snapshot()).rejects.toThrow('invalid_member');
  });
  test('frozen member remains present but is unavailable', async () => {
    users.ou_b.status = { ...state, is_frozen: true };
    expect((await provider.snapshot()).members[1].status).toBe('frozen');
  });
  test('an empty, complete visibility snapshot is valid', async () => {
    view.users = [];
    expect((await provider.snapshot()).members).toEqual([]);
  });
  test('a provider failure is not an empty snapshot', async () => {
    api.call.mockRejectedValue(new Error('offline'));
    await expect(provider.snapshot()).rejects.toThrow('offline');
  });
  test('the official all-visible response omits empty lists', async () => {
    view = { is_visible_to_all: 1, has_more_users: 0, user_page_token: '' };
    api.pages.mockImplementation(async (p: string) =>
      p.includes('children') ? [] : [users.ou_a, users.ou_b],
    );
    expect((await provider.snapshot()).members).toHaveLength(2);
  });
  test('all-member scope can enumerate departments and individual members without root zero', async () => {
    view = { is_visible_to_all: 1, has_more_users: 0 };
    api.call.mockImplementation(async (p: string, params: any) =>
      p.includes('visibility')
        ? view
        : p.includes('scopes')
          ? params.page_token
            ? { department_ids: ['team'], has_more: false }
            : { user_ids: ['ou_a'], has_more: true, page_token: 'page2' }
          : { user: users[p.split('/').pop()] },
    );
    api.pages.mockImplementation(async (p: string) =>
      p.includes('children') ? [] : [users.ou_b],
    );
    expect((await provider.snapshot()).members.map((m) => m.subject)).toEqual([
      'ou_a',
      'ou_b',
    ]);
    expect(api.call).toHaveBeenCalledWith(
      '/contact/v3/scopes',
      expect.objectContaining({ page_token: 'page2' }),
    );
  });
  test('incomplete contact scope pagination fails rather than removing members', async () => {
    view.is_visible_to_all = 1;
    api.call.mockImplementation(async (p: string) =>
      p.includes('visibility')
        ? view
        : { department_ids: ['team'], has_more: true, page_token: '' },
    );
    await expect(provider.snapshot()).rejects.toThrow('invalid_pagination');
  });
  test('a visibility page with more users cannot omit the user list', async () => {
    view = {
      is_visible_to_all: 1,
      has_more_users: 1,
      user_page_token: 'page2',
    };
    await expect(provider.snapshot()).rejects.toThrow('invalid_visibility');
  });
  test('loops and incomplete pagination are rejected', async () => {
    view.has_more_users = 1;
    view.user_page_token = 'same';
    await expect(provider.snapshot()).rejects.toThrow('invalid_pagination');
  });
  test('all-member visibility requires a complete, well-formed contact scope', async () => {
    view.is_visible_to_all = 1;
    api.call.mockImplementation(async (p: string) =>
      p.includes('visibility')
        ? view
        : { department_ids: 'malformed', has_more: false },
    );
    await expect(provider.snapshot()).rejects.toThrow('invalid_contact_scope');
  });
  test('expands departments recursively and applies department exclusions', async () => {
    view.users = [];
    view.departments = [{ id: 'parent' }];
    view.invisible_departments = [{ id: 'child' }];
    api.pages.mockImplementation(async (p: string, params: any) =>
      p.includes('children')
        ? p.includes('parent')
          ? [{ department_id: 'child' }]
          : []
        : params.department_id === 'parent'
          ? [users.ou_a]
          : [users.ou_b],
    );
    expect((await provider.snapshot()).members.map((m) => m.subject)).toEqual([
      'ou_a',
    ]);
  });
  test('expands user and department members of groups', async () => {
    view.users = [];
    view.groups = [{ id: 'group' }];
    api.pages.mockImplementation(async (p: string, params: any) =>
      p.includes('simplelist')
        ? params.member_type === 'user'
          ? [{ member_id: 'ou_a', member_type: 'user' }]
          : [{ member_id: 'child', member_type: 'department' }]
        : p.includes('children')
          ? []
          : [users.ou_b],
    );
    expect((await provider.snapshot()).members.map((m) => m.subject)).toEqual([
      'ou_a',
      'ou_b',
    ]);
  });
});
