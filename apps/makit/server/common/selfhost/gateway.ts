import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** Only the trusted HTTPS proxy may reach business routes through the tunnel. */
export function gatewayAllowed(req: Pick<Request, 'path' | 'method' | 'headers'>): boolean {
  if (process.env.MAKIT_REQUIRE_GATEWAY !== 'true') return true;
  if (['GET', 'HEAD'].includes(req.method) && ['/healthz', '/readyz'].includes(req.path)) return true;
  const expected = process.env.MAKIT_GATEWAY_KEY || '', provided = req.headers['x-makit-gateway-key'];
  return expected.length >= 32 && typeof provided === 'string' &&
    Buffer.byteLength(expected) === Buffer.byteLength(provided) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}
