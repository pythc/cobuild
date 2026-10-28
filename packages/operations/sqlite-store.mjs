import { randomUUID } from 'node:crypto';
import { ContractError, canonicalJSON, fingerprint, resourceRef, uuid } from '../contracts/index.mjs';

/** Runs on the owning business database. No separate connection or background writer. */
export function operationStore(db, { registry, now = Date.now }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_operations_v1(
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, subject TEXT NOT NULL,
      request_id TEXT NOT NULL, action TEXT NOT NULL, resource_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(organization_id,subject,request_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS collaboration_events_v1(
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES collaboration_operations_v1(id),
      envelope_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS collaboration_deliveries_v1(
      event_id TEXT NOT NULL REFERENCES collaboration_events_v1(id),
      consumer TEXT NOT NULL, projection_key TEXT NOT NULL, generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','retry_wait','blocked','succeeded')),
      receipt_json TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(event_id,consumer)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS collaboration_projection_v1
      ON collaboration_deliveries_v1(consumer,projection_key,generation);
  `);
  function transaction(fn) {
    // SAVEPOINT allows callers to include their own mutation/queue transaction.
    db.exec('SAVEPOINT collaboration_command');
    try { const result = fn(); db.exec('RELEASE collaboration_command'); return result; }
    catch (error) { db.exec('ROLLBACK TO collaboration_command; RELEASE collaboration_command'); throw error; }
  }
  function read(id) {
    const row = db.prepare('SELECT * FROM collaboration_operations_v1 WHERE id=?').get(id);
    if (!row) throw new ContractError('OPERATION_NOT_FOUND', 404);
    const deliveries = db.prepare(`SELECT d.consumer,d.generation,d.state,d.receipt_json,d.updated_at
      FROM collaboration_deliveries_v1 d JOIN collaboration_events_v1 e ON e.id=d.event_id
      WHERE e.operation_id=? ORDER BY d.consumer`).all(id).map(r => ({
      consumer: r.consumer, generation: r.generation, state: r.state,
      receipt: r.receipt_json ? JSON.parse(r.receipt_json) : null, updatedAt: r.updated_at,
    }));
    const state = ['blocked', 'retry_wait', 'running', 'queued'].find(s => deliveries.some(d => d.state === s)) || 'succeeded';
    return { id, action: row.action, resource: JSON.parse(row.resource_json), revision: row.revision,
      state, committed: true, createdAt: row.created_at, deliveries };
  }
  return {
    execute(command, { authorize, mutate }) {
      const { subject, requestId, action, resource, input } = command;
      resourceRef(resource); registry.assertAction(action, resource);
      if (!uuid(requestId) || typeof subject !== 'string' || !subject || subject.length > 200) throw new ContractError('INVALID_COMMAND');
      const serialized = canonicalJSON(input);
      if (Buffer.byteLength(serialized) > 32768) throw new ContractError('COMMAND_TOO_LARGE', 413);
      const digest = fingerprint({ action, resource, input });
      return transaction(() => {
        // Authorization is deliberately before the replay lookup. Receipt possession
        // and a prior success never replace the actor's current permissions.
        if (authorize()?.then) throw new Error('Authorization must be synchronous');
        const old = db.prepare(`SELECT id,fingerprint FROM collaboration_operations_v1
          WHERE organization_id=? AND subject=? AND request_id=?`).get(resource.organizationId, subject, requestId);
        if (old) {
          if (old.fingerprint !== digest) throw new ContractError('REQUEST_CONFLICT', 409);
          return { ...read(old.id), replayed: true };
        }
        const result = mutate();
        if (!result || result.then || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('Invalid synchronous mutation result');
        const id = randomUUID(), time = now();
        db.prepare('INSERT INTO collaboration_operations_v1 VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id, resource.organizationId, subject, requestId, action, JSON.stringify(resource), digest, result.revision, time);
        if (result.event) {
          registry.assertEvent(result.event.type, resource);
          const eventId = randomUUID();
          const envelope = { specversion: '1.0', id: eventId, source: 'urn:cobuild:' + resource.organizationId + ':' + resource.appId,
            type: result.event.type, subject: resource.type + '/' + resource.id, time: new Date(time).toISOString(),
            datacontenttype: 'application/json', data: { ...result.event.data, resource, revision: result.revision, operationId: id } };
          db.prepare('INSERT INTO collaboration_events_v1 VALUES(?,?,?)').run(eventId, id, canonicalJSON(envelope));
          for (const projection of result.projections || []) {
            if (!/^[a-z][a-z0-9.-]{0,100}$/.test(projection.consumer) || typeof projection.key !== 'string' || !projection.key ||
                !Number.isSafeInteger(projection.generation) || projection.generation < 1) throw new Error('Invalid projection binding');
            db.prepare(`INSERT INTO collaboration_deliveries_v1 VALUES(?,?,?,?,'queued',NULL,?)`)
              .run(eventId, projection.consumer, projection.key, projection.generation, time);
          }
        } else if (result.projections?.length) throw new Error('Projection requires an event');
        return { ...read(id), replayed: false };
      });
    },
    get(id, authorize) {
      if (!uuid(id)) throw new ContractError('OPERATION_NOT_FOUND', 404);
      const operation = read(id);
      if (authorize(operation)?.then) throw new Error('Authorization must be synchronous');
      return operation;
    },
    // Snapshot projection adapter: a confirmed newer generation covers older events.
    // This does NOT claim that every intermediate state was delivered remotely.
    project(consumer, key, generation, state, receipt = null) {
      if (!Number.isSafeInteger(generation) || generation < 1 || !['queued','running','retry_wait','blocked','succeeded'].includes(state)) throw new Error('Invalid projection progress');
      if(state==='succeeded'&&!receipt)throw new Error('Confirmed projection requires a receipt');
      db.prepare(`UPDATE collaboration_deliveries_v1 SET state=?,receipt_json=?,updated_at=?
        WHERE consumer=? AND projection_key=? AND generation<=? AND state<>'succeeded'`)
        .run(state, receipt ? canonicalJSON(receipt) : null, now(), consumer, key, generation);
    },
  };
}
