import { matchesDefaultGroup } from './default-group-search';
describe('localized default group search', () => {
  test.each(['', '全体', '全体成员', '自动同步', '所有成员', 'Everyone', ' ALL MEMBERS '])('matches %p', (query) => expect(matchesDefaultGroup(query)).toBe(true));
  test.each(['不存在', 'Engineering', '%', "' or true --"])('does not match unrelated query %p', (query) => expect(matchesDefaultGroup(query)).toBe(false));
});
