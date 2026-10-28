import { createHash } from 'node:crypto';

// Dependency-free wire contracts. These functions validate shape, not authority.
export class ContractError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'ContractError'; this.code = code; this.status = status; }
}
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function exact(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !fields.includes(k))) throw new ContractError('INVALID_CONTRACT');
}
export function resourceRef(value) {
  exact(value, ['organizationId', 'appId', 'type', 'id']);
  if (!uuid(value.organizationId) || !uuid(value.id) || !/^[a-z][a-z0-9-]{0,62}$/.test(value.appId || '') || !/^[a-z][a-z0-9-]{0,62}$/.test(value.type || '')) throw new ContractError('INVALID_RESOURCE');
  return Object.freeze({ ...value });
}
export function canonicalJSON(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  throw new ContractError('INVALID_JSON');
}
export const fingerprint = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');

/** Trusted built-ins only. Registering a manifest does not load code or grant permissions. */
export function createModuleRegistry(manifests) {
  const modules = new Map(), actions = new Map(), events = new Map(), applications = new Map();
  for (const raw of manifests) {
    exact(raw, ['id','name','tier','source','dependsOn','owns','contractVersion','applications','actions','events']);
    const m = structuredClone(raw);
    if (m.contractVersion !== 1 || !/^[a-z][a-z0-9-]*$/.test(m.id || '') || modules.has(m.id)) throw new ContractError('INVALID_MODULE');
    for (const field of ['dependsOn', 'owns', 'applications', 'actions', 'events']) {
      if (!Array.isArray(m[field]) || m[field].some(v => typeof v !== 'string') || new Set(m[field]).size !== m[field].length) throw new ContractError('INVALID_MODULE');
    }
    for (const [field, map] of [['actions', actions], ['events', events], ['applications', applications]]) {
      for (const name of m[field]) {
        if (!/^[a-z][a-z0-9.-]{0,150}$/.test(name) || map.has(name) || (field !== 'applications' && !name.startsWith(m.id + '.'))) throw new ContractError('DUPLICATE_OR_UNOWNED_CAPABILITY');
        map.set(name, m.id);
      }
    }
    modules.set(m.id, Object.freeze(m));
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (!modules.has(id)) throw new ContractError('MISSING_DEPENDENCY');
    if (visiting.has(id)) throw new ContractError('CYCLIC_DEPENDENCY');
    if (visited.has(id)) return;
    visiting.add(id); modules.get(id).dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  }
  modules.forEach((_, id) => visit(id));
  return Object.freeze({
    ids: Object.freeze([...modules.keys()]),
    applicationOwner: name => applications.get(name),
    assertAction(name, resource) {
      resourceRef(resource);
      if (actions.get(name) !== resource.appId || !modules.get(resource.appId)?.owns.includes(resource.type)) throw new ContractError('UNREGISTERED_ACTION');
    },
    assertEvent(name, resource) {
      if (events.get(name) !== resource.appId || !modules.get(resource.appId)?.owns.includes(resource.type)) throw new ContractError('UNREGISTERED_EVENT');
    },
  });
}
