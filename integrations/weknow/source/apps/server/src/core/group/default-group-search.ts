/** Match UI labels without renaming the persisted system group. */
export function matchesDefaultGroup(query: string): boolean {
  const term = query.trim().toLowerCase();
  return [
    'everyone',
    'all members (automatic)',
    '全体成员（自动同步）',
    '所有成员',
  ].some((name) => name.includes(term));
}
