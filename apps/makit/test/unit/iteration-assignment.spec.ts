import { iterationAssignmentError } from '../../shared/iteration-assignment';

describe('single iteration assignment contract', () => {
  it.each([{ ids: [] }, { ids: ['rec_one'] }])(
    'accepts empty or singleton links: %j',
    ({ ids }) => {
      expect(iterationAssignmentError(ids)).toBeNull();
    },
  );

  it.each(
    [null, undefined, 'rec_one', {}, [1], [''], [' rec_one'], ['rec_one ']].map(
      (value) => ({ value }),
    ),
  )('rejects malformed input %j without throwing', ({ value }) => {
    expect(iterationAssignmentError(value)).toContain('格式不正确');
  });

  it('does not truncate, deduplicate, or mutate legacy associations', () => {
    const ids = Object.freeze(['rec_one', 'rec_two']);
    expect(iterationAssignmentError(ids)).toContain('只能关联一个迭代');
    expect(ids).toEqual(['rec_one', 'rec_two']);
    expect(iterationAssignmentError(['rec_one', 'rec_one'])).toContain(
      '只能关联一个迭代',
    );
  });
});
