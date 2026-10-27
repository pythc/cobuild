import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { HttpException } from '@nestjs/common';

export const KNOWLEDGE_ACCESS = '110lab.knowledge.oauth';
export const SCOPES = [
  'knowledge:read',
  'knowledge:write',
  'knowledge:manage',
  'knowledge:mail',
] as const;
export type KnowledgeScope = (typeof SCOPES)[number];
export const SCOPE_LABELS: Record<KnowledgeScope, string> = {
  'knowledge:read': '读取你有权查看的文档、目录、评论与附件',
  'knowledge:write': '编辑你有编辑权限的内容，创建、移动和恢复文档',
  'knowledge:manage': '执行你有管理权限的空间、成员及删除操作',
  'knowledge:mail': '为你明确选择的文档准备邮件内容',
};
export const hash = (v: string | Buffer) =>
  createHash('sha256').update(v).digest('hex');
export const secret = (prefix: string) =>
  prefix + randomBytes(32).toString('base64url');
export const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class OAuthError extends HttpException {
  constructor(error: string, description: string, status = 400) {
    super({ error, error_description: description }, status);
  }
}
export function parseScopes(value: unknown): KnowledgeScope[] {
  if (value === undefined || value === '') return ['knowledge:read'];
  if (typeof value !== 'string' || value.length > 256)
    throw new OAuthError('invalid_scope', 'Invalid scope');
  const items = [...new Set(value.split(' ').filter(Boolean))];
  if (!items.length || items.some((s) => !SCOPES.includes(s as KnowledgeScope)))
    throw new OAuthError('invalid_scope', 'Unsupported scope');
  return items as KnowledgeScope[];
}
export function hasScope(scopes: string[], required: KnowledgeScope) {
  return (
    scopes.includes(required) ||
    (required === 'knowledge:read' && scopes.includes('knowledge:write'))
  );
}
export function validRedirect(raw: unknown): raw is string {
  if (
    typeof raw !== 'string' ||
    raw.length > 2048 ||
    /[\\\u0000-\u0020\u007f#]/.test(raw)
  )
    return false;
  try {
    const u = new URL(raw);
    // Compatibility exception for the reviewed desktop callback, never arbitrary schemes.
    if(raw==='workbuddy://oauth/callback')return true;
    return (
      !u.username &&
      !u.password &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
export function redirectMatches(requested: string, registered: string) {
  if (!validRedirect(requested) || !validRedirect(registered)) return false;
  if (requested === registered) return true;
  const rx =
    /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]))(?::\d+)?([/?].*)?$/;
  const a = rx.exec(requested),
    b = rx.exec(registered);
  return !!a && !!b && a[1] === b[1] && a[2] === b[2];
}
export function canonicalOrigin(raw: string) {
  const u = new URL(raw);
  if (
    u.username ||
    u.password ||
    u.pathname !== '/' ||
    u.search ||
    u.hash ||
    !(
      u.protocol === 'https:' ||
      (u.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
    )
  )
    throw new Error('Knowledge APP_URL requires HTTPS or loopback HTTP origin');
  return u.origin;
}
export function assertBrowserOrigin(actual: unknown, expected: string) {
  if (actual !== expected)
    throw new OAuthError(
      'invalid_request',
      'Use the original knowledge browser',
      403,
    );
}
