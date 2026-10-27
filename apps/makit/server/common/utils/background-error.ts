/** Do not log raw database/HTTP errors: they may contain SQL parameters,
 * requirement material, authorization headers or model request bodies.
 * Preserve error codes and call sites (including nested driver causes) instead.
 */
export function backgroundErrorDiagnostic(error: unknown): string {
  const causes: Array<{ name: string; code: string | null; stack: string[] }> =
    [];
  const seen: Set<object> = new Set();
  let current: unknown = error;
  while (
    current &&
    typeof current === 'object' &&
    !seen.has(current) &&
    causes.length < 5
  ) {
    seen.add(current);
    const value = current as Record<string, unknown>;
    const code: unknown = value.code ?? value.errorCode;
    causes.push({
      name:
        typeof value.name === 'string' && /^[\w.]{1,80}$/u.test(value.name)
          ? value.name
          : 'Error',
      code:
        typeof code === 'string' && /^[\w.:-]{1,80}$/u.test(code) ? code : null,
      // Error messages and SQL can span multiple lines. Only V8 call frames are safe.
      stack:
        typeof value.stack === 'string'
          ? value.stack
              .split('\n')
              .filter((line: string) => /^\s+at /u.test(line))
              .filter(
                (line: string) => !/https?:\/\/|[?=]|Bearer |sk-/iu.test(line),
              )
              .slice(0, 15)
          : [],
    });
    current = value.cause;
  }
  return JSON.stringify({ causes });
}
