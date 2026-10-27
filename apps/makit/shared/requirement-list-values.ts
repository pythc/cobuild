export const NORMAL_STATUS_ORDER: string[] = [
  '新',
  '需求已评审',
  '开发中',
  '开发转测试',
  '测试中',
  '产品体验中',
  '待发布',
  '已发布',
];

const LEGACY_NORMAL_STATUS_ALIASES: Readonly<Record<string, string>> = {
  需求待评审: '新',
  已评审: '需求已评审',
  发布中: '待发布',
};

export const STATUS_ORDER: string[] = NORMAL_STATUS_ORDER;

export const DEFECT_STATUS_ORDER: string[] = [
  '新建',
  '处理中',
  '已解决',
  '已验证',
  '已关闭',
];

export const DEFECT_BRANCH_STATUSES: string[] = ['重新打开', '已拒绝'];

const STATUS_RANK: ReadonlyMap<string, number> = new Map(
  NORMAL_STATUS_ORDER.map((status: string, index: number): [string, number] => [
    status,
    index,
  ]),
);

function parseShanghaiString(value: string): number | null {
  const trimmed: string = value.trim();
  if (!trimmed) return null;
  if (/Z$|[+-]\d{2}:?\d{2}$/u.test(trimmed)) {
    const parsedWithZone: number = Date.parse(trimmed);
    return Number.isNaN(parsedWithZone) ? null : parsedWithZone;
  }
  const normalized: string = trimmed.includes('T')
    ? trimmed
    : trimmed.replace(' ', 'T');
  const withTime: string = /^\d{4}-\d{2}-\d{2}$/u.test(normalized)
    ? `${normalized}T00:00:00`
    : normalized;
  const parsed: number = Date.parse(`${withTime}+08:00`);
  return Number.isNaN(parsed) ? null : parsed;
}

export function timestamp(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const text: string = String(value);
  const numeric: number = Number(text);
  if (
    Number.isFinite(numeric) &&
    numeric > 10_000_000_000 &&
    /^\d+$/u.test(text)
  ) {
    return numeric;
  }
  return parseShanghaiString(text);
}

export function statusRank(status: string): number | null {
  return STATUS_RANK.get(normalizeRequirementStatus(status)) ?? null;
}

export function workflowStatusSortRank(status: string): number {
  const normalRank: number | null = statusRank(status);
  if (normalRank != null) return normalRank;
  const defectRank: number = [
    ...DEFECT_STATUS_ORDER,
    ...DEFECT_BRANCH_STATUSES,
  ].indexOf(status);
  return defectRank < 0
    ? Number.MAX_SAFE_INTEGER
    : NORMAL_STATUS_ORDER.length + defectRank;
}

export function normalizeRequirementStatus(status: string): string {
  if (status === '待验证') return '已解决';
  return LEGACY_NORMAL_STATUS_ALIASES[status] || status;
}
