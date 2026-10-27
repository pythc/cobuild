import { excerpt, searchTerms, likeLiteral } from './search-text';
describe('search snippets', () => {
  it('matches Chinese terms and escapes HTML', () => {
    expect(excerpt('这里有<script>权限控制</script>', ['权限控制'])).toContain(
      '&lt;script&gt;<mark>权限控制</mark>&lt;/script&gt;',
    );
  });
  it('treats query as literals', () => {
    expect(likeLiteral('50%_\\')).toBe('%50\\%\\_\\\\%');
    expect(excerpt('a+b', ['a+b'])).toContain('<mark>a+b</mark>');
  });
  it('normalizes whitespace and full width terms', () => {
    expect(searchTerms(' Ａ　权限 ')).toEqual(['a', '权限']);
    expect(searchTerms('1 2 3 4 5 6 7 8 9')).toHaveLength(8);
  });
});
