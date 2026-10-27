import type {
  RequirementPatch,
  RequirementSummary,
  RequirementUpdateInput,
} from './api.interface';

export const PERSONNEL_PATCH_FIELDS = {
  handlers: ['handlerUserIds', 'handlerLarkUserIds'],
  productOwners: ['productOwnerUserIds', 'productOwnerLarkUserIds'],
  developers: ['developerUserIds', 'developerLarkUserIds'],
  testers: ['testerUserIds', 'testerLarkUserIds'],
  foOwners: ['foOwnerUserIds', 'foOwnerLarkUserIds'],
  proposers: ['proposerUserIds', 'proposerLarkUserIds'],
  followers: ['followerUserIds', 'followerLarkUserIds'],
  releaseOwners: ['releaseOwnerUserIds', 'releaseOwnerLarkUserIds'],
} as const;

export function normalizedOperationValue(value: unknown): unknown {
  if (typeof value === 'string') value = value.trim();
  if (value == null || value === '' || value === '未设置') return null;
  if (Array.isArray(value)) return [...new Set(value.map(String))].sort();
  if (typeof value === 'string') return value.trim();
  return value;
}

export function operationValuesEqual(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(normalizedOperationValue(a)) ===
    JSON.stringify(normalizedOperationValue(b))
  );
}

export function currentPatchValues(
  current: RequirementSummary,
  patch: RequirementPatch,
): RequirementPatch {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    const personnel = Object.entries(PERSONNEL_PATCH_FIELDS).find(
      ([, fields]) => fields.some((field) => field === key),
    );
    if (personnel && personnel[1][1] === key) {
      result[key] =
        current.personnelUserIds[
          personnel[0] as keyof typeof PERSONNEL_PATCH_FIELDS
        ] || [];
    } else if (!personnel && key in current) {
      result[key] = current[key as keyof RequirementSummary];
    }
  }
  return result as RequirementPatch;
}

/** Preserve explicit personnel additions/removals across concurrent edits. */
export function prepareOperationInput(
  current: RequirementSummary,
  input: RequirementUpdateInput,
): RequirementUpdateInput {
  const baseValues =
    input.baseValues || currentPatchValues(current, input.patch);
  const personnelChanges = { ...input.personnelChanges };
  for (const [role, fields] of Object.entries(PERSONNEL_PATCH_FIELDS)) {
    if (personnelChanges[role as keyof typeof PERSONNEL_PATCH_FIELDS]) continue;
    // Feishu employee IDs are present in requirementPersonnel. Miaoda IDs must
    // first be resolved server-side and must never be compared as another ID namespace.
    const key = fields[1];
    const desired = input.patch[key];
    const previous = baseValues[key];
    if (!Array.isArray(desired) || !Array.isArray(previous)) continue;
    const prior = new Set(previous);
    const next = new Set(desired);
    personnelChanges[role as keyof typeof PERSONNEL_PATCH_FIELDS] = {
      add: [...next].filter((id) => !prior.has(id)),
      remove: [...prior].filter((id) => !next.has(id)),
      identityType: 'feishu',
    };
  }
  return { ...input, baseValues, personnelChanges };
}

export interface OperationFieldConflict {
  field: string;
  base: unknown;
  current: unknown;
  intended: unknown;
}

/** Three-way compare. No global timestamp-based permission to overwrite. */
export function mergeOperationPatch(
  current: RequirementSummary,
  input: RequirementUpdateInput,
): {
  patch: RequirementPatch;
  conflicts: OperationFieldConflict[];
} {
  const patch: RequirementPatch = { ...input.patch };
  const currentValues = currentPatchValues(current, patch);
  const conflicts: OperationFieldConflict[] = [];
  const personnelKeys = new Set<string>();
  for (const [role, delta] of Object.entries(input.personnelChanges || {})) {
    if (
      !delta ||
      delta.identityType !== 'feishu' ||
      !(role in PERSONNEL_PATCH_FIELDS)
    )
      continue;
    const typedRole = role as keyof typeof PERSONNEL_PATCH_FIELDS;
    const [miaodaKey, feishuKey] = PERSONNEL_PATCH_FIELDS[typedRole];
    const values = new Set(current.personnelUserIds[typedRole] || []);
    for (const id of delta.remove) values.delete(id);
    for (const id of delta.add) values.add(id);
    delete patch[miaodaKey];
    patch[feishuKey] = [...values];
    personnelKeys.add(feishuKey);
  }
  for (const [field, intended] of Object.entries(patch)) {
    if (personnelKeys.has(field)) continue;
    const key = field as keyof RequirementPatch;
    const value = currentValues[key];
    if (operationValuesEqual(value, intended)) continue;
    if (
      input.baseValues &&
      Object.prototype.hasOwnProperty.call(input.baseValues, key)
    ) {
      if (!operationValuesEqual(value, input.baseValues[key])) {
        conflicts.push({
          field,
          base: input.baseValues[key],
          current: value,
          intended,
        });
      }
    } else if (
      String(input.expectedUpdatedAt ?? '') !== String(current.updatedAt ?? '')
    ) {
      conflicts.push({ field, base: null, current: value, intended });
    }
  }
  return { patch, conflicts };
}
