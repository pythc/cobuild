// Only deployment-owned loopback endpoints may replace network transport.
// Public issuer, callback, receipt origins and authorization checks stay intact.
import { request } from 'node:http';
import { Readable } from 'node:stream';
export function transportOrigin(origin) {
  if (!process.env.COBUILD_BACKCHANNELS) return origin;
  const map = JSON.parse(process.env.COBUILD_BACKCHANNELS);
  if (!map || Array.isArray(map) || typeof map !== 'object') throw Error('Invalid backchannels');
  const target = Object.prototype.hasOwnProperty.call(map, origin) ? map[origin] : origin;
  if (target === origin) return origin;
  const u = new URL(target);
  if (u.origin !== target || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port)
    throw Error('Backchannel must be explicit loopback HTTP');
  return target;
}
// Node fetch can discard a supplied Host header. Use node:http only for an
// explicitly configured loopback backchannel, retaining the public Host.
export async function transportFetch(origin, path, options = {}) {
  if (!path.startsWith('/') || path.startsWith('//')) throw Error('Explicit service path required');
  const target = transportOrigin(origin);
  if (target === origin) return fetch(origin + path, options);
  if (options.body !== undefined && typeof options.body !== 'string') throw Error('String request body required');
  return new Promise((resolve, reject) => {
    const req = request(target + path, { method: options.method || 'GET',
      headers: { ...Object.fromEntries(new Headers(options.headers)), Host: new URL(origin).host },
      signal: options.signal || undefined,
    }, incoming => {
      const status = incoming.statusCode || 500;
      if (status >= 300 && status < 400) { incoming.destroy(); reject(Error('Backchannel redirect rejected')); return; }
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i+1]);
      resolve(new Response([204,304].includes(status) ? null : Readable.toWeb(incoming), { status, headers }));
    });
    req.once('error', reject);
    req.end(options.body);
  });
}
