import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  createPublicKey,
} from 'node:crypto';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
const AAD = '110lab-requirements-native-consent-v1';
export interface IdentityTicket {
  token: string;
  publicKey: string;
  requestNonce: string;
  state: string;
  redirectUri: string;
  expires: number;
}
function key() {
  const s = process.env.MCP_PERSONAL_TOKEN_SECRET || '';
  if (Buffer.byteLength(s) < 32)
    throw new ServiceUnavailableException('统一连接尚未配置');
  return createHash('sha256')
    .update(AAD + ':' + s)
    .digest();
}
export function validTicketInput(v: any): Omit<IdentityTicket, 'expires'> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).some(
      (k) =>
        ![
          'token',
          'publicKey',
          'requestNonce',
          'state',
          'redirectUri',
        ].includes(k),
    ) ||
    !/^[\w-]{43}$/.test(v.token || '') ||
    !/^[\w-]{43}$/.test(v.state || '') ||
    !/^[\w-]{22}$/.test(v.requestNonce || '') ||
    typeof v.publicKey !== 'string' ||
    v.publicKey.length > 2048 ||
    !/^[-\w]+$/.test(v.publicKey)
  )
    throw new BadRequestException('连接请求无效');
  let u: URL;
  try {
    u = new URL(v.redirectUri);
  } catch {
    throw new BadRequestException();
  }
  if (
    u.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
    !u.port ||
    u.pathname !== '/callback/110lab_requirements' ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  )
    throw new BadRequestException('回调地址无效');
  try {
    const k = createPublicKey({
        key: Buffer.from(v.publicKey, 'base64url'),
        format: 'der',
        type: 'spki',
      }),
      n = k.asymmetricKeyDetails?.modulusLength || 0;
    if (k.asymmetricKeyType !== 'rsa' || n < 2048 || n > 4096)
      throw new Error();
  } catch {
    throw new BadRequestException('连接公钥无效');
  }
  return v;
}
export function sealTicket(input: any) {
  const valid = validTicketInput(input),
    iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(AAD));
  const bytes = Buffer.concat([
    c.update(
      JSON.stringify({ ...valid, expires: Date.now() + 600000 }),
      'utf8',
    ),
    c.final(),
  ]);
  return [
    iv.toString('base64url'),
    bytes.toString('base64url'),
    c.getAuthTag().toString('base64url'),
  ].join('.');
}
export function openTicket(value: string): IdentityTicket {
  try {
    if (typeof value !== 'string' || value.length > 12000) throw new Error();
    const [i, b, t, ...extra] = value.split('.');
    if (extra.length || !i || !b || !t) throw new Error();
    const c = createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(i, 'base64url'),
    );
    c.setAAD(Buffer.from(AAD));
    c.setAuthTag(Buffer.from(t, 'base64url'));
    const p = JSON.parse(
      Buffer.concat([
        c.update(Buffer.from(b, 'base64url')),
        c.final(),
      ]).toString('utf8'),
    );
    if (
      !Number.isInteger(p.expires) ||
      p.expires <= Date.now() ||
      p.expires > Date.now() + 600000 + 5000
    )
      throw new Error();
    const { expires, ...rest } = p;
    validTicketInput(rest);
    return p;
  } catch {
    throw new BadRequestException('连接请求已失效，请从插件重新连接');
  }
}
