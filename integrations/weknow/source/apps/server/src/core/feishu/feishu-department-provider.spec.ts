import { loadDepartmentGroups } from './feishu-department-provider';
const node = (id: string, parent = '0', name = id) => ({
  open_department_id: id,
  parent_department_id: parent,
  name,
});
describe('Feishu organization group snapshot', () => {
  let rows: any[], direct: Record<string, string[]>, api: any;
  beforeEach(() => {
    rows = [
      node('od-child', 'od-parent', '开发'),
      node('od-parent', '0', '110lab'),
      node('od-empty', 'od-parent', '产品'),
    ];
    direct = {
      'od-parent': ['ou-a'],
      'od-child': ['ou-b', 'ou-a', 'ou-outside'],
      'od-empty': [],
    };
    api = {
      pages: jest.fn(async (path, params) =>
        path.includes('children')
          ? rows
          : direct[params.department_id].map((open_id) => ({ open_id })),
      ),
    };
  });
  test('resolves hierarchy, aggregates descendants and deduplicates only authorized members', async () => {
    const result = await loadDepartmentGroups(api, new Set(['ou-a', 'ou-b']));
    expect(result.find((d) => d.id === 'od-parent')).toMatchObject({
      path: '110lab',
      subjects: ['ou-a', 'ou-b'],
    });
    expect(result.find((d) => d.id === 'od-child')).toMatchObject({
      path: '110lab / 开发',
      subjects: ['ou-a', 'ou-b'],
    });
    expect(result.find((d) => d.id === 'od-empty')?.subjects).toEqual([]);
    expect(api.pages).toHaveBeenCalledWith(
      '/contact/v3/departments/0/children',
      expect.objectContaining({
        department_id_type: 'open_department_id',
        fetch_child: 'true',
      }),
      'items',
    );
  });
  test.each([
    [node('od-a', 'od-b'), node('od-b', 'od-a')],
    [node('od-a', 'od-missing')],
    [node('od-a'), node('od-a')],
    [{ open_department_id: 'od-a', parent_department_id: '0' }],
    [node('reusable-custom-id')],
    [{ ...node('od-a'), status: { is_deleted: true } }],
  ])(
    'rejects incomplete, cyclic, duplicate or unstable department identities',
    async (...items) => {
      rows = items;
      await expect(loadDepartmentGroups(api, new Set())).rejects.toThrow();
    },
  );
  test('API/permission failure never becomes an empty valid snapshot', async () => {
    api.pages.mockRejectedValue(new Error('permission denied'));
    await expect(loadDepartmentGroups(api, new Set())).rejects.toThrow(
      'permission denied',
    );
  });
  test('a complete empty organization is valid', async () => {
    rows = [];
    expect(await loadDepartmentGroups(api, new Set())).toEqual([]);
  });
  test('a failed membership page invalidates the whole collection', async () => {
    api.pages.mockImplementation(async (path) => {
      if (path.includes('children')) return rows;
      throw new Error('page failure');
    });
    await expect(loadDepartmentGroups(api, new Set())).rejects.toThrow(
      'page failure',
    );
  });
});
