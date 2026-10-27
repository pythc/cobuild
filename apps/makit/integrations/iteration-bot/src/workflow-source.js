// A scanner reports only native gaps between confirmed platform writes.
// No value-only or timestamp-only matching and no silent fallback on API errors.
export const CONFIRMED_SOURCE = 'confirmed_operations_v1';
export function confirmedSourceEnabled() { return process.env.WORKFLOW_EVENT_SOURCE === CONFIRMED_SOURCE; }
export function nativeWorkflowSegments(previous, current, edges, makeSnapshot, importantFields) {
  if (!Array.isArray(edges) || edges.length > 100) throw new Error('Invalid workflow source chain');
  const segments = [];
  let cursor = previous;
  for (const edge of edges) {
    if (!edge?.operationId || edge.after?.notificationMarker !== `op_v1:${edge.operationId}` ||
      (edge.before?.notificationMarker || '') !== (cursor?.notificationMarker || ''))
      throw new Error('Workflow source chain does not match snapshot baseline');
    const project = (snapshot) => makeSnapshot({ ...snapshot,
      startDate:snapshot.startAt, deadline:snapshot.deadlineAt,
      developmentStart:snapshot.developmentStartAt, developmentEnd:snapshot.developmentEndAt,
      testDate:snapshot.testingAt, actualStart:snapshot.actualStartAt,
      actualTest:snapshot.actualTestingAt, actualRelease:snapshot.actualReleaseAt,
    });
    const before = project(edge.before), after = project(edge.after);
    segments.push({ previous: cursor, snapshot: before, segmentId: `before:${edge.operationId}` });
    if (!Array.isArray(edge.fields)) throw new Error('Missing confirmed write fields');
    // The write receipt may also contain an unrelated native edit made after the
    // platform's pre-read. Only the fields actually written belong to the operation.
    const residual = structuredClone(after);
    for (const [key, label] of importantFields) {
      if (edge.fields.includes(label) || edge.fields.includes(key) ||
        (key === 'title' && edge.fields.includes('需求'))) residual[key] = before[key];
    }
    residual.notificationMarker = before.notificationMarker;
    segments.push({ previous: before, snapshot: residual, segmentId: `during:${edge.operationId}` });
    cursor = after;
  }
  if ((cursor?.notificationMarker || '') !== (current.notificationMarker || ''))
    throw new Error('Workflow source chain is incomplete');
  segments.push({ previous: cursor, snapshot: current, segmentId: `tail:${current.notificationMarker || 'native'}` });
  return segments;
}
