import { iterationDeliveryTiming } from '../../client/src/lib/iteration-health';

describe('iterationDeliveryTiming', () => {
  const now: number = Date.parse('2026-08-12T12:00:00+08:00');

  it('falls back to the iteration end date and marks unfinished work high risk', () => {
    const timing = iterationDeliveryTiming(
      {
        releaseAt: null,
        endAt: Date.parse('2026-08-09T12:00:00+08:00'),
      },
      2,
      now,
    );

    expect(timing.usesEndDateFallback).toBe(true);
    expect(timing.overdueDays).toBe(3);
    expect(timing.highRisk).toBe(true);
    expect(timing.remainingDays).toBe(0);
  });

  it('prefers the release milestone over the iteration end date', () => {
    const releaseAt: number = Date.parse('2026-08-15T12:00:00+08:00');
    const timing = iterationDeliveryTiming(
      {
        releaseAt,
        endAt: Date.parse('2026-08-09T12:00:00+08:00'),
      },
      2,
      now,
    );

    expect(timing.deadlineAt).toBe(releaseAt);
    expect(timing.usesEndDateFallback).toBe(false);
    expect(timing.remainingDays).toBe(3);
    expect(timing.highRisk).toBe(false);
  });

  it('does not mark a completed iteration high risk after its deadline', () => {
    const timing = iterationDeliveryTiming(
      {
        releaseAt: null,
        endAt: Date.parse('2026-08-09T12:00:00+08:00'),
      },
      0,
      now,
    );

    expect(timing.overdueDays).toBe(0);
    expect(timing.highRisk).toBe(false);
  });

  it('treats a date-only milestone as the end of the Shanghai calendar day', () => {
    const timing = iterationDeliveryTiming(
      { releaseAt: '2026-08-12', endAt: null },
      2,
      now,
    );

    expect(timing.highRisk).toBe(false);
    expect(timing.remainingDays).toBe(1);
  });

  it('normalizes Base timestamps stored at Shanghai midnight to day end', () => {
    const timing = iterationDeliveryTiming(
      {
        releaseAt: Date.parse('2026-08-12T00:00:00+08:00'),
        endAt: null,
      },
      2,
      now,
    );

    expect(timing.highRisk).toBe(false);
    expect(timing.remainingDays).toBe(1);
  });
});
