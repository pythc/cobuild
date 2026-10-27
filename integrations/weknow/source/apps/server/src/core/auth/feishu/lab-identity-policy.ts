import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  UnauthorizedException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
const identityLogger = new Logger('LabIdentity');
export const LAB_ISSUER = 'https://internal.110-lab.cn';
export function sealIdentity(token: string, sessionId: string, key: string) {
  const iv = randomBytes(12),
    c = createCipheriv(
      'aes-256-gcm',
      createHash('sha256')
        .update('lab-identity:' + key)
        .digest(),
      iv,
    );
  c.setAAD(Buffer.from(sessionId));
  return [
    iv.toString('base64url'),
    Buffer.concat([c.update(token, 'utf8'), c.final()]).toString('base64url'),
    c.getAuthTag().toString('base64url'),
  ].join('.');
}
export function unsealIdentity(sealed: string, sessionId: string, key: string) {
  try {
    const [iv, b, t] = sealed.split('.'),
      c = createDecipheriv(
        'aes-256-gcm',
        createHash('sha256')
          .update('lab-identity:' + key)
          .digest(),
        Buffer.from(iv, 'base64url'),
      );
    c.setAAD(Buffer.from(sessionId));
    c.setAuthTag(Buffer.from(t, 'base64url'));
    return Buffer.concat([
      c.update(Buffer.from(b, 'base64url')),
      c.final(),
    ]).toString('utf8');
  } catch {
    throw new UnauthorizedException();
  }
}
export function identityEndpoint(config: any) {
  const origin = config.get('LAB_IDENTITY_ORIGIN', LAB_ISSUER),
    u = new URL(origin);
  if (
    u.origin !== origin ||
    u.username ||
    u.password ||
    (u.origin !== LAB_ISSUER &&
      !(
        config.get('LAB_IDENTITY_LOCAL_TEST') === 'true' &&
        u.protocol === 'http:' &&
        u.hostname === '127.0.0.1'
      ))
  )
    throw new ServiceUnavailableException('统一认证配置无效');
  return origin;
}
export async function identityRequest(
  config: any,
  kind: 'exchange' | 'inspect',
  input: any,
) {
  const origin = identityEndpoint(config);
  let base = origin;
  if (
    config.get('LAB_IDENTITY_LOCAL_TEST') === 'true' &&
    config.get('LAB_IDENTITY_BACKCHANNEL')
  ) {
    const u = new URL(config.get('LAB_IDENTITY_BACKCHANNEL'));
    if (
      u.protocol !== 'http:' ||
      u.hostname !== 'host.docker.internal' ||
      u.pathname !== '/' ||
      u.search ||
      u.hash
    )
      throw new ServiceUnavailableException();
    base = u.origin;
  }
  let response: Response;
  // Inspection is read-only. Exchange consumes a one-use code and must not be
  // replayed when the outcome of a network request is unknown.
  const attempts = kind === 'inspect' ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      response = await fetch(base + '/api/identity/' + kind, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audience: 'knowledge', ...input }),
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      identityLogger.warn(
        JSON.stringify({
          event: 'identity_request_failed',
          kind,
          reason: 'network',
          attempts: attempt + 1,
        }),
      );
      throw new ServiceUnavailableException('暂时无法核对统一身份');
    }
    if (response.ok) break;
    await response.body?.cancel();
    if ([401, 403].includes(response.status)) {
      identityLogger.warn(
        JSON.stringify({
          event: 'identity_request_failed',
          kind,
          reason: 'rejected',
          status: response.status,
        }),
      );
      throw new UnauthorizedException('统一登录已失效');
    }
    if ([502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      continue;
    }
    identityLogger.warn(
      JSON.stringify({
        event: 'identity_request_failed',
        kind,
        reason: 'upstream',
        status: response.status,
        attempts: attempt + 1,
      }),
    );
    throw new ServiceUnavailableException('暂时无法核对统一身份');
  }
  let size = 0,
    parts: Uint8Array[] = [];
  const reader = response.body!.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.length) > 8192) {
        await reader.cancel();
        throw new UnauthorizedException();
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let p: any;
  try {
    p = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new UnauthorizedException();
  }
  if (
    p.issuer !== LAB_ISSUER ||
    p.audience !== 'knowledge' ||
    p.tenantKey !== config.get('FEISHU_TENANT_KEY') ||
    !/^on_[\w-]{10,100}$/.test(p.unionId || '') ||
    p.subject !== p.tenantKey + ':' + p.unionId ||
    !Number.isFinite(Date.parse(p.expiresAt)) ||
    Date.parse(p.expiresAt) <= Date.now() ||
    Date.parse(p.expiresAt) > Date.now() + 30 * 86400000 + 5000 ||
    (kind === 'exchange' && !/^[\w-]{43}$/.test(p.token || ''))
  )
    throw new UnauthorizedException('统一身份响应无效');
  return p;
}
