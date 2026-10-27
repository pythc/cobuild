import type {
  PersonRef,
  RequirementPersonnelResponse,
  RequirementUpdateInput,
} from '@shared/api.interface';
import { PERSONNEL_PATCH_FIELDS } from '@shared/requirement-operation';
import type { User } from '@/components/business-ui/types/user';

/** A list row omits personnel IDs. Use the authoritative editor snapshot as
 * the merge base so removing/replacing people cannot become an add-only edit. */
export function personnelUpdateInput(
  snapshot: RequirementPersonnelResponse,
  role: keyof typeof PERSONNEL_PATCH_FIELDS,
  users: User[],
): RequirementUpdateInput {
  const key = PERSONNEL_PATCH_FIELDS[role][1];
  return {
    expectedUpdatedAt: snapshot.updatedAt,
    patch: { [key]: employeeUserIds(users) },
    baseValues: { [key]: [...snapshot.personnelUserIds[role]] },
  };
}

export function employeeUsers(ids: string[], people: PersonRef[]): User[] {
  return ids.map((id, index) => ({
    employee_id: id,
    name: people[index]?.name || '成员',
    user_type: '_employee',
  }));
}

export function employeeUserIds(users: User[]): string[] {
  return [
    ...new Set(users.map((user) => user.employee_id || '').filter(Boolean)),
  ];
}

export function employeePersonRefs(users: User[]): PersonRef[] {
  return users.map(
    (user: User): PersonRef => ({
      id: user.employee_id || user.user_id || '',
      name:
        typeof user.name === 'string'
          ? user.name || '成员'
          : user.name?.zh_cn || user.name?.en_us || '成员',
    }),
  );
}

export function mergeEmployeeUsers(current: User[], additions: User[]): User[] {
  const merged: Map<string, User> = new Map();
  [...current, ...additions].forEach((user: User): void => {
    if (!user.employee_id) return;
    merged.set(user.employee_id, user);
  });
  return [...merged.values()];
}

export function sameEmployeeUsers(left: User[], right: User[]): boolean {
  return (
    JSON.stringify(employeeUserIds(left).sort()) ===
    JSON.stringify(employeeUserIds(right).sort())
  );
}
