import { createHash } from 'node:crypto';
import type { RequirementUpdateInput } from '@shared/api.interface';
import { PERSONNEL_PATCH_FIELDS } from '@shared/requirement-operation';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function operationRequestHash(
  requirementId: string,
  input: RequirementUpdateInput,
): string {
  const request = { ...input };
  delete request.clientMutationId;
  return createHash('sha256')
    .update(JSON.stringify(canonical({ requirementId, ...request })))
    .digest('hex');
}

export function mcpMutationHash(
  tool: string,
  input: Record<string, unknown>,
): string {
  const request = { ...input };
  delete request.clientMutationId;
  return createHash('sha256')
    .update(JSON.stringify(canonical({ tool, request })))
    .digest('hex');
}

export function validateOperationEnvelope(input: RequirementUpdateInput): void {
  if (
    !input ||
    !input.patch ||
    typeof input.patch !== 'object' ||
    Array.isArray(input.patch)
  ) {
    throw new Error('修改内容无效');
  }
  if (input.recoveryOf !== undefined && (typeof input.recoveryOf !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(input.recoveryOf)))
    throw new Error('待修正的操作编号无效');
  if (
    input.clientMutationId &&
    !/^[a-zA-Z0-9_-]{8,128}$/u.test(input.clientMutationId)
  ) {
    throw new Error('操作标识无效');
  }
  if (input.source && !['web', 'mcp', 'bulk'].includes(input.source))
    throw new Error('操作来源无效');
  for (const value of [input.baseValues, input.personnelChanges]) {
    if (
      value !== undefined &&
      (!value || typeof value !== 'object' || Array.isArray(value))
    )
      throw new Error('修改基线或人员增删内容无效');
  }
  for (const [miaoda, feishu] of Object.values(PERSONNEL_PATCH_FIELDS)) {
    if (input.patch[miaoda] !== undefined && input.patch[feishu] !== undefined)
      throw new Error('同一人员字段不能混用两种身份标识');
    // No authoritative Miaoda-ID baseline exists in requirement summaries.
    if (input.baseValues?.[miaoda] !== undefined)
      throw new Error('人员修改基线请使用飞书身份标识');
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 262144)
    throw new Error('修改内容过大，请分段保存');
  for (const [role, delta] of Object.entries(input.personnelChanges || {})) {
    if (
      ![
        'handlers',
        'productOwners',
        'developers',
        'testers',
        'foOwners',
        'proposers',
        'followers',
        'releaseOwners',
      ].includes(role) ||
      !delta ||
      delta.identityType !== 'feishu' ||
      !Array.isArray(delta.add) ||
      !Array.isArray(delta.remove) ||
      [...delta.add, ...delta.remove].some(
        (id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id),
      ) ||
      delta.add.some((id) => delta.remove.includes(id)) ||
      delta.add.length + delta.remove.length > 200
    )
      throw new Error('人员增删内容无效');
  }
}
