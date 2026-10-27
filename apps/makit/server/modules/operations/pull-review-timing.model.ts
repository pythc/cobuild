import { distributionQuantile } from '@shared/iteration-analysis';
export interface ReviewTimingAssignment {
  login: string;
  at: string;
}
export interface ReviewTimingReview {
  login: string;
  at: string;
}

/** Confirmed assignments only; sorted per reviewer, no per-assignment full-history scans. */
export function pullReviewTiming(
  assignments: ReviewTimingAssignment[],
  reviews: ReviewTimingReview[],
  requested: string[],
  now: number,
) {
  const group = (entries: Array<{ login: string; at: string }>) => {
    const result = new Map<string, number[]>();
    for (const item of entries) {
      const time = Date.parse(item.at),
        login = item.login.toLowerCase();
      if (!login || !Number.isFinite(time)) continue;
      const list = result.get(login) || [];
      list.push(time);
      result.set(login, list);
    }
    for (const [login, list] of result)
      result.set(
        login,
        [...new Set(list)].sort((a, b) => a - b),
      );
    return result;
  };
  const requests = group(assignments),
    submitted = group(reviews),
    requestedSet = new Set(requested.map((r) => r.toLowerCase()));
  const completed: Array<{ requestedAt: number; reviewedAt: number }> = [],
    waits: number[] = [],
    repeats: number[] = [];
  for (const [login, times] of requests) {
    const responses = submitted.get(login) || [];
    let cursor = 0;
    for (let index = 0; index < times.length; index++) {
      const at = times[index],
        next = times[index + 1] ?? Infinity;
      while (cursor < responses.length && responses[cursor] < at) cursor++;
      const review = responses[cursor];
      if (review !== undefined && review < next) {
        completed.push({ requestedAt: at, reviewedAt: review });
        if (index > 0) repeats.push((review - at) / 3_600_000);
      } else if (index === times.length - 1 && requestedSet.has(login))
        waits.push(Math.max(0, now - at) / 3_600_000);
    }
  }
  completed.sort((a, b) => a.reviewedAt - b.reviewedAt);
  return {
    firstReviewHours: completed.length
      ? (completed[0].reviewedAt - completed[0].requestedAt) / 3_600_000
      : null,
    waitingReviewHours: waits.length ? Math.max(...waits) : null,
    repeatReviewHours: distributionQuantile(repeats, 0.5),
    repeatReviewSamples: repeats.length,
  };
}
