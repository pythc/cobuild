import { requirementComplete } from '../../../shared/ticket-workflow';
import { createHash } from 'node:crypto';
import type { WorkspaceResponse } from '@shared/api.interface';

// Use the workbench's isMine result: Base list people use open IDs, whereas
// personnelUserIds on detail responses use employee IDs. Never compare names.
export function personalRequirementTodos(
  workspace: WorkspaceResponse,
  input: { limit: number; cursor?: string },
) {
  const items = workspace.requirements
    .filter(
      (item) => item.isMine && !requirementComplete(item),
    )
    .map((item) => ({
      id: item.id,
      code: item.code,
      title: item.title,
      status: item.status,
      project: item.project,
      deadlineAt: item.deadlineAt,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const snapshot = createHash('sha256')
    .update(JSON.stringify([workspace.currentUser.miaodaUserId, items]))
    .digest('hex');
  let offset = 0;
  if (input.cursor) {
    const match = /^([a-f0-9]{64}):([1-9]\d{0,8})$/u.exec(input.cursor);
    if (!match || match[1] !== snapshot || Number(match[2]) >= items.length) {
      return { restartRequired: true, requirements: [], nextCursor: null };
    }
    offset = Number(match[2]);
  }
  const requirements = items.slice(offset, offset + input.limit);
  const end = offset + requirements.length;
  return {
    restartRequired: false,
    requirements,
    total: items.length,
    nextCursor: end < items.length ? `${snapshot}:${end}` : null,
    accountName: workspace.currentUser.name,
    fetchedAt: workspace.fetchedAt,
    stale: workspace.freshness?.stale === true,
  };
}
