import type { PersonRef, RequirementSummary } from '@shared/api.interface';

export const WORKFLOW_MARKER_FIELD = '平台操作标识';
export const WORKFLOW_SOURCE_VERSION = 'confirmed_operations_v1';
export function confirmedWorkflowSource(): boolean {
  return process.env.WORKFLOW_EVENT_SOURCE === WORKFLOW_SOURCE_VERSION;
}
export function operationMarker(operationId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(operationId))
    throw new Error('Invalid operation identifier');
  return `op_v1:${operationId}`;
}
export function markerOperation(marker: unknown): string | null {
  if (typeof marker !== 'string') return null;
  const id = marker.slice(6);
  try { return operationMarker(id) === marker ? id : null; } catch { return null; }
}
export interface ConfirmedWorkflowEdge {
  operationId: string;
  fields: string[];
  before: RequirementSummary;
  after: RequirementSummary;
}

/** Follow same-write receipts, never correlate two writes by values or wall-clock proximity. */
export async function workflowEdges(
  previous: string, current: string,
  read: (operationId: string) => Promise<ConfirmedWorkflowEdge | null>,
): Promise<ConfirmedWorkflowEdge[]> {
  const edges: ConfirmedWorkflowEdge[] = [];
  const seen = new Set<string>();
  let marker = current;
  while (marker !== previous) {
    const id = markerOperation(marker);
    if (!id || seen.has(id) || edges.length >= 100)
      throw new Error('workflow_source_chain_incomplete');
    seen.add(id);
    const edge = await read(id);
    if (!edge || edge.operationId !== id || edge.after.notificationMarker !== marker)
      throw new Error('workflow_source_confirmation_pending');
    edges.push(edge);
    marker = edge.before.notificationMarker || '';
  }
  return edges.reverse();
}

const PERSONNEL = ['handlers', 'productOwners', 'developers', 'testers', 'foOwners',
  'proposers', 'followers', 'releaseOwners'] as const;

/** Confirmed write snapshots use employee IDs. Notification consumers require open IDs. */
export async function notificationIdentities(
  snapshots: RequirementSummary[], resolve: (employeeId: string) => Promise<string>,
): Promise<RequirementSummary[]> {
  const result = snapshots.map((snapshot) => structuredClone(snapshot));
  const ids = [...new Set(result.flatMap((snapshot) =>
    PERSONNEL.flatMap((key) => (snapshot[key] || []).map((person) => person.id))))];
  const resolved = new Map<string, string>();
  // Bound directory requests; conversion never runs on the interactive save path.
  for (let offset = 0; offset < ids.length; offset += 5) {
    await Promise.all(ids.slice(offset, offset + 5).map(async (id) => {
      const openId = await resolve(id);
      if (!/^ou_[A-Za-z0-9_-]+$/u.test(openId)) throw new Error('workflow_person_identity_unresolved');
      resolved.set(id, openId);
    }));
  }
  for (const snapshot of result) for (const key of PERSONNEL)
    snapshot[key] = (snapshot[key] || []).map((person: PersonRef) => ({ ...person, id: resolved.get(person.id)! }));
  return result;
}
