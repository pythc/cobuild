import { createHash, timingSafeEqual } from 'node:crypto';
export function safeReturnPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\s\\]|\p{C}/u.test(value)
  )
    return '/home';
  try {
    const base = 'https://knowledge.invalid';
    const target = new URL(value, base);
    if (
      target.origin !== base ||
      target.pathname.startsWith('//') ||
      /^\/(login|api\/auth)(\/|$)/i.test(target.pathname)
    )
      return '/home';
    return target.pathname + target.search + target.hash;
  } catch {
    return '/home';
  }
}
export function hashState(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function equalSecret(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function identityAllowed(
  info: { tenant_key?: string; open_id?: string },
  tenant: string,
): boolean {
  return (
    !!tenant &&
    info.tenant_key === tenant &&
    typeof info.open_id === 'string' &&
    /^ou_[a-zA-Z0-9_-]{5,200}$/.test(info.open_id)
  );
}
export function splitIds(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
}
