import { Transaction } from 'kysely';
import { hashState } from '../auth/feishu/feishu-policy';
import { DirectoryDepartment } from './feishu-department-provider';

export interface DepartmentScope {
  appId: string;
  tenant: string;
  workspaceId: string;
}
export function departmentGroupPrefix(
  scope: Pick<DepartmentScope, 'appId' | 'tenant'>,
) {
  return (
    'feishu-department:' +
    hashState(JSON.stringify([scope.appId, scope.tenant])) +
    ':'
  );
}
function managed(trx: Transaction<any>, scope: DepartmentScope) {
  return trx
    .selectFrom('groups')
    .selectAll()
    .where('workspaceId', '=', scope.workspaceId)
    .where('isExternal', '=', true)
    .where('scimExternalId', 'like', departmentGroupPrefix(scope) + '%');
}

export async function removeUserFromDepartmentGroups(
  trx: Transaction<any>,
  scope: DepartmentScope,
  userId: string,
) {
  await trx
    .deleteFrom('groupUsers')
    .where('userId', '=', userId)
    .where('groupId', 'in', managed(trx, scope).clearSelect().select('id'))
    .execute();
}

export async function invalidateDepartmentGroup(
  trx: Transaction<any>,
  scope: DepartmentScope,
  id: string,
) {
  const group = await managed(trx, scope)
    .where('scimExternalId', '=', departmentGroupPrefix(scope) + id)
    .forUpdate()
    .executeTakeFirst();
  if (!group) return;
  const affected = await trx
    .selectFrom('groupUsers')
    .select('userId')
    .where('groupId', '=', group.id)
    .execute();
  // Also remove stale inherited grants. A fresh snapshot restores memberships in
  // any other departments, without ever retaining the deleted department's access.
  if (affected.length)
    await trx
      .deleteFrom('groupUsers')
      .where(
        'userId',
        'in',
        affected.map((row) => row.userId),
      )
      .where('groupId', 'in', managed(trx, scope).clearSelect().select('id'))
      .execute();
  await trx
    .updateTable('groups')
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where('id', '=', group.id)
    .execute();
}

export async function syncDepartmentGroups(
  trx: Transaction<any>,
  scope: DepartmentScope,
  departments: DirectoryDepartment[],
  startedAt: Date,
) {
  const prefix = departmentGroupPrefix(scope);
  const previous = await managed(trx, scope).forUpdate().execute();
  const active = await trx
    .selectFrom('feishuIdentities as f')
    .innerJoin('users as u', 'u.id', 'f.userId')
    .select(['f.subject', 'u.id'])
    .where('f.appId', '=', scope.appId)
    .where('f.tenantKey', '=', scope.tenant)
    .where('f.workspaceId', '=', scope.workspaceId)
    .where('u.workspaceId', '=', scope.workspaceId)
    .where('f.directoryStatus', '=', 'active')
    .where('u.deletedAt', 'is', null)
    .where('u.deactivatedAt', 'is', null)
    .execute();
  const activeIds = active.map((row) => row.id);
  if (previous.length) {
    let removeInactive = trx.deleteFrom('groupUsers').where(
      'groupId',
      'in',
      previous.map((group) => group.id),
    );
    if (activeIds.length)
      removeInactive = removeInactive.where('userId', 'not in', activeIds);
    await removeInactive.execute();
  }
  // A directory event during collection invalidates the membership snapshot.
  // requestSync schedules another pass; don't undo a newer deletion or transfer.
  const newerEvent = await trx
    .selectFrom('feishuEvents')
    .select('eventId')
    .where('receivedAt', '>', startedAt)
    .limit(1)
    .executeTakeFirst();
  if (newerEvent) return;
  const bySubject = new Map(active.map((row) => [row.subject, row.id]));
  const wanted = new Set(
    departments.map((department) => prefix + department.id),
  );
  const staleIds = previous
    .filter((group) => !wanted.has(group.scimExternalId))
    .map((group) => group.id);
  if (staleIds.length) {
    await trx
      .deleteFrom('groupUsers')
      .where('groupId', 'in', staleIds)
      .execute();
    await trx
      .updateTable('groups')
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where('id', 'in', staleIds)
      .execute();
  }
  for (const department of departments) {
    const externalId = prefix + department.id;
    const existing = previous.find(
      (group) => group.scimExternalId === externalId,
    );
    const base = ('飞书 · ' + department.path).slice(0, 100);
    let name = base;
    // Never merge into a manually created or identically named department group.
    for (let attempt = 0; ; attempt++) {
      const occupied = await trx
        .selectFrom('groups')
        .select('id')
        .where('workspaceId', '=', scope.workspaceId)
        .where('name', '=', name)
        .executeTakeFirst();
      if (!occupied || occupied.id === existing?.id) break;
      if (attempt >= 10) throw new Error('department_group_name_conflict');
      name =
        base.slice(0, 85) +
        ' · ' +
        hashState(externalId + ':' + attempt).slice(0, 10);
    }
    const values = {
      name,
      description: `飞书组织架构：${department.path}。包含下级部门成员，成员随飞书自动同步。`,
      isDefault: false,
      isExternal: true,
      scimExternalId: externalId,
      workspaceId: scope.workspaceId,
      deletedAt: null,
      updatedAt: new Date(),
    };
    const group = existing
      ? await trx
          .updateTable('groups')
          .set(values)
          .where('id', '=', existing.id)
          .returning('id')
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('groups')
          .values(values)
          .returning('id')
          .executeTakeFirstOrThrow();
    const userIds = [
      ...new Set(
        department.subjects
          .map((subject) => bySubject.get(subject))
          .filter(Boolean),
      ),
    ];
    let remove = trx.deleteFrom('groupUsers').where('groupId', '=', group.id);
    if (userIds.length) remove = remove.where('userId', 'not in', userIds);
    await remove.execute();
    if (userIds.length)
      await trx
        .insertInto('groupUsers')
        .values(userIds.map((userId) => ({ userId, groupId: group.id })))
        .onConflict((oc) => oc.columns(['userId', 'groupId']).doNothing())
        .execute();
  }
}
