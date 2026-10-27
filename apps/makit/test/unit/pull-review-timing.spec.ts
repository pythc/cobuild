import { pullReviewTiming } from '../../server/modules/operations/pull-review-timing.model';
const at = (hour: number) =>
  new Date(Date.UTC(2026, 8, 12, hour)).toISOString();
describe('confirmed PR review clocks', () => {
  it('uses actual earliest review, not assignment enumeration order', () => {
    expect(
      pullReviewTiming(
        [
          { login: 'a', at: at(0) },
          { login: 'b', at: at(1) },
        ],
        [
          { login: 'a', at: at(8) },
          { login: 'b', at: at(3) },
        ],
        [],
        Date.parse(at(9)),
      ).firstReviewHours,
    ).toBe(2);
  });
  it('a rerequest does not count old assignment time as current waiting', () => {
    expect(
      pullReviewTiming(
        [
          { login: 'a', at: at(0) },
          { login: 'a', at: at(5) },
        ],
        [],
        ['A'],
        Date.parse(at(7)),
      ).waitingReviewHours,
    ).toBe(2);
  });
  it('a review only completes its own assignment generation', () => {
    expect(
      pullReviewTiming(
        [
          { login: 'a', at: at(0) },
          { login: 'a', at: at(5) },
        ],
        [{ login: 'a', at: at(6) }],
        ['a'],
        Date.parse(at(7)),
      ),
    ).toEqual({
      firstReviewHours: 1,
      waitingReviewHours: null,
      repeatReviewHours: 1,
      repeatReviewSamples: 1,
    });
  });
});
