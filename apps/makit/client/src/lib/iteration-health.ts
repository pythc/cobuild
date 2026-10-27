import type { IterationSummary } from '@shared/api.interface';

const DAY_MS: number = 86_400_000;

function deliveryTimestamp(value: string | number | null): number | null {
  if (value == null || value === '') return null;
  const text: string = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    return Date.parse(`${text}T23:59:59.999+08:00`);
  }
  const raw: number =
    typeof value === 'number' || /^\d{11,}$/u.test(text)
      ? Number(value)
      : Date.parse(text.replace(' ', 'T'));
  if (!Number.isFinite(raw)) return null;
  // Base date fields are commonly serialized as Shanghai midnight. A
  // delivery date remains valid through that calendar day, not only at 00:00.
  const shanghaiOffset: number = 8 * 60 * 60 * 1_000;
  return (raw + shanghaiOffset) % DAY_MS === 0 ? raw + DAY_MS - 1 : raw;
}

export interface IterationDeliveryTiming {
  deadlineAt: string | number | null;
  remainingDays: number | null;
  overdueDays: number;
  highRisk: boolean;
  usesEndDateFallback: boolean;
}

export function iterationDeliveryTiming(
  iteration: Pick<IterationSummary, 'releaseAt' | 'endAt'>,
  unfinishedCount: number,
  now: number = Date.now(),
): IterationDeliveryTiming {
  const usesEndDateFallback: boolean = !iteration.releaseAt;
  const deadlineAt: string | number | null =
    iteration.releaseAt || iteration.endAt;
  const deadline: number | null = deliveryTimestamp(deadlineAt);
  if (deadline == null) {
    return {
      deadlineAt,
      remainingDays: null,
      overdueDays: 0,
      highRisk: false,
      usesEndDateFallback,
    };
  }
  const highRisk: boolean = unfinishedCount > 0 && deadline < now;
  return {
    deadlineAt,
    remainingDays: deadline >= now ? Math.ceil((deadline - now) / DAY_MS) : 0,
    overdueDays: highRisk
      ? Math.max(1, Math.ceil((now - deadline) / DAY_MS))
      : 0,
    highRisk,
    usesEndDateFallback,
  };
}
