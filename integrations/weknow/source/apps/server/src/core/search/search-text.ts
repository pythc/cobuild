export function searchTerms(value: string): string[] {
  return [
    ...new Set(
      value.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean),
    ),
  ].slice(0, 8);
}
export function likeLiteral(s: string) {
  return '%' + s.replace(/[\\%_]/g, '\\$&') + '%';
}
export function excerpt(text: string, terms: string[]) {
  const normal = text.toLowerCase();
  const positions = terms.map((t) => normal.indexOf(t)).filter((i) => i >= 0);
  const at = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, at - 55),
    end = Math.min(text.length, at + 180);
  const escape = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c]!,
    );
  let out = '',
    i = start;
  while (i < end) {
    const hit = terms.find((t) => normal.startsWith(t, i));
    if (hit) {
      out += '<mark>' + escape(text.slice(i, i + hit.length)) + '</mark>';
      i += hit.length;
    } else out += escape(text[i++]);
  }
  return (start ? '…' : '') + out + (end < text.length ? '…' : '');
}
