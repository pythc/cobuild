import {
  WritingBuffer,
  countWritingCharacters,
  writingWeek,
} from './writing-policy';
describe('weekly writing attribution', () => {
  test('counts Unicode characters rather than bytes or UTF-16 units', () =>
    expect(countWritingCharacters('你 好 A\n😀')).toBe(4));
  test.each([
    ['2026-10-11T15:59:59Z', '2026-10-04T16:00:00.000Z'],
    ['2026-10-11T16:00:00Z', '2026-10-11T16:00:00.000Z'],
    ['2026-10-17T03:00:00Z', '2026-10-11T16:00:00.000Z'],
    ['2026-10-18T16:00:00Z', '2026-10-18T16:00:00.000Z'],
  ])('uses Monday midnight in Asia/Shanghai: %s', (now, start) => {
    const week = writingWeek(new Date(now));
    expect(week.start.toISOString()).toBe(start);
    expect(week.end.getTime() - week.start.getTime()).toBe(7 * 86400_000);
  });
  test('attributes interleaved changes to the actual actor and buckets edits', () => {
    const b = new WritingBuffer();
    b.loaded('doc', '你好');
    b.changed('doc', 'a', '你好世界', 1000);
    b.changed('doc', 'b', '你好世界！', 2000);
    b.changed('doc', 'a', '你好世界！again', 3000);
    const rows = b.take('doc');
    expect(rows.map((r) => [r.userId, r.charsDelta])).toEqual([
      ['a', 7],
      ['b', 1],
    ]);
    expect(rows.every((r) => r.bucket.getTime() === 0)).toBe(true);
  });
  test('tracks removals as negative net changes and excludes unauthenticated initialization', () => {
    const b = new WritingBuffer();
    b.changed('doc', 'a', 'initial');
    expect(b.take('doc')).toEqual([]);
    b.changed('doc', undefined, '你好');
    expect(b.take('doc')).toEqual([]);
    b.changed('doc', 'a', '你');
    expect(b.take('doc')[0].charsDelta).toBe(-1);
  });
  test('retries uncertain commits using stable IDs without merging later edits', () => {
    const b = new WritingBuffer();
    b.loaded('d', '');
    b.changed('d', 'a', 'A', 1000);
    const first = b.take('d');
    b.changed('d', 'a', 'AB', 2000);
    b.restore('d', first);
    const next = b.take('d');
    expect(next).toHaveLength(2);
    expect(next.map((r) => r.charsDelta)).toEqual([1, 1]);
    expect(next.some((r) => r.id === first[0].id)).toBe(true);
  });
});
