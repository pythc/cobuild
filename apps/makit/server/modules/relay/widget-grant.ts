import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
interface WidgetIdentity {
  subject: string;
  name: string;
}
export function issueWidgetGrant(identity: WidgetIdentity, challenge: unknown) {
  const key = process.env.RELAY_WIDGET_SIGNING_KEY;
  if (!key || key.length < 43)
    throw new ServiceUnavailableException('客服尚未配置');
  if (
    typeof challenge !== 'string' ||
    !/^[\w-]{43}$/.test(challenge) ||
    !identity.subject ||
    !identity.name.trim()
  )
    throw new BadRequestException('客服身份无效');
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      aud: 'relay-widget-v1',
      iss: 'makit',
      app: 'makit',
      origin: process.env.MAKIT_STORAGE === 'postgres'
        ? new URL(process.env.MAKIT_PUBLIC_URL || '').origin : 'https://fcncvoyreb8p.feishuapp.com',
      sub: identity.subject,
      name: identity.name.slice(0, 80),
      challenge,
      iat: now,
      exp: now + 90000,
      jti: randomBytes(32).toString('base64url'),
    }),
  ).toString('base64url');
  return {
    grant:
      payload +
      '.' +
      createHmac('sha256', key).update(payload).digest('base64url'),
  };
}
