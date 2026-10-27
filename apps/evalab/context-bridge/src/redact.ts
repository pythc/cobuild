/**
 * Obvious credential markers. Keep this list aligned with server/src/mcp.ts.
 * Lowercase prose such as "private key" is intentionally left alone.
 */
export const SECRET_SOURCES = [
  '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)',
  '\\bsk-[A-Za-z0-9_-]{20,}',
  '\\bsk-ant-[A-Za-z0-9_-]{10,}\\b',
  '\\bghp_[A-Za-z0-9]{20,}',
  '\\bgithub_pat_[A-Za-z0-9_]{20,}',
  '\\bAKIA[0-9A-Z]{16}',
  '\\bASIA[0-9A-Z]{16}',
  '\\bxox[baprs]-[A-Za-z0-9-]{10,}',
  '\\bglpat-[A-Za-z0-9_-]{16,}',
  '\\bBearer\\s+[A-Za-z0-9\\-._~+/=]{20,}',
  '\\bcrsr_[A-Za-z0-9_-]{20,}\\b',
] as const;

const SECRET_SOURCES_I = [
  String.raw`\b(?:password|passwd|pwd|api[_-]?key|secret(?:[_-]?key)?|access[_-]?key)\b["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)`,
  String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@`,
] as const;

const SECRET_SOURCES_U = [
  String.raw`(?:密码|密钥)["']?\s*[:：=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)`,
] as const;

export function containsSecretMarker(input: string): boolean {
  return rules().some((rule) => rule.test(input));
}

export function redactText(input: string): { text: string; redactions: number } {
  let text = input;
  let redactions = 0;
  for (const rule of rules()) {
    text = text.replace(rule, () => {
      redactions += 1;
      return '[REDACTED]';
    });
  }
  return { text, redactions };
}

function rules(): RegExp[] {
  return [
    ...SECRET_SOURCES.map((source) => new RegExp(source, 'g')),
    ...SECRET_SOURCES_I.map((source) => new RegExp(source, 'gi')),
    ...SECRET_SOURCES_U.map((source) => new RegExp(source, 'g')),
  ];
}
