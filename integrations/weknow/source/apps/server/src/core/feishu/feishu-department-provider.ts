import { FeishuApiError, FeishuApiService } from './feishu-api.service';

export interface DirectoryDepartment {
  id: string;
  parentId: string;
  name: string;
  path: string;
  subjects: string[];
}

/** A complete, validated organization snapshot; never publish partial pages. */
export async function loadDepartmentGroups(
  api: FeishuApiService,
  allowedSubjects: Set<string>,
): Promise<DirectoryDepartment[]> {
  const rows = await api.pages(
    '/contact/v3/departments/0/children',
    {
      department_id_type: 'open_department_id',
      fetch_child: 'true',
      page_size: '50',
    },
    'items',
  );
  const departments = new Map<string, DirectoryDepartment>();
  for (const row of rows) {
    // Custom department_id can be reused after deletion. Only immutable open IDs
    // may identify a permission group, so a recreated department gets a new group.
    if (
      typeof row.open_department_id !== 'string' ||
      !/^od[-_][A-Za-z0-9_-]{1,250}$/.test(row.open_department_id) ||
      typeof row.parent_department_id !== 'string' ||
      (row.parent_department_id !== '0' &&
        !/^od[-_][A-Za-z0-9_-]{1,250}$/.test(row.parent_department_id)) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 1000 ||
      row.status?.is_deleted === true ||
      departments.has(row.open_department_id)
    )
      throw new FeishuApiError('invalid_department_snapshot');
    departments.set(row.open_department_id, {
      id: row.open_department_id,
      parentId: row.parent_department_id,
      name: row.name.trim(),
      path: '',
      subjects: [],
    });
  }
  const visit = (id: string, chain = new Set<string>()): string => {
    const department = departments.get(id);
    if (!department || chain.has(id) || chain.size > 100)
      throw new FeishuApiError('invalid_department_hierarchy');
    if (department.path) return department.path;
    chain.add(id);
    department.path =
      department.parentId === '0'
        ? department.name
        : visit(department.parentId, chain) + ' / ' + department.name;
    chain.delete(id);
    return department.path;
  };
  for (const department of departments.values()) visit(department.id);
  const direct = new Map<string, Set<string>>();
  for (const department of departments.values()) {
    const users = await api.pages(
      '/contact/v3/users/find_by_department',
      {
        department_id: department.id,
        department_id_type: 'open_department_id',
        user_id_type: 'open_id',
        page_size: '50',
      },
      'items',
    );
    const subjects = new Set<string>();
    for (const user of users) {
      if (typeof user.open_id !== 'string' || !user.open_id)
        throw new FeishuApiError('invalid_department_member');
      if (allowedSubjects.has(user.open_id)) subjects.add(user.open_id);
    }
    direct.set(department.id, subjects);
  }
  // Union direct members into every ancestor, deduplicating multi-department users.
  const inherited = new Map(
    [...direct].map(([id, members]) => [id, new Set(members)]),
  );
  for (const department of departments.values()) {
    let parent = department.parentId;
    while (parent !== '0') {
      for (const subject of direct.get(department.id)!)
        inherited.get(parent)!.add(subject);
      parent = departments.get(parent)!.parentId;
    }
  }
  return [...departments.values()].map((department) => ({
    ...department,
    subjects: [...inherited.get(department.id)!].sort(),
  }));
}
