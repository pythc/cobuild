import { ServiceUnavailableException } from '@nestjs/common';
import type { ChatwootClient } from './chatwoot-client';
import { relayFilename } from './relay-chatwoot.message';
export function relayStorageRedirect(
  location: string,
  source: URL,
  prefix: string,
): URL {
  const next = new URL(location, source);
  if (next.origin !== source.origin || next.username || next.password)
    throw new ServiceUnavailableException('附件跳转无效');
  // Rails may generate an origin-root storage redirect behind a path proxy.
  // Restore only this known storage namespace, never an arbitrary URL.
  if (prefix && next.pathname.startsWith('/rails/active_storage/'))
    next.pathname = prefix + next.pathname;
  if (!next.pathname.startsWith(prefix + '/rails/active_storage/'))
    throw new ServiceUnavailableException('附件跳转无效');
  return next;
}
export async function downloadRelayAttachment(chat: ChatwootClient, file: any) {
  const url = new URL(file.data_url),
    origin = chat.config().origin;
  if (
    url.origin !== new URL(origin).origin ||
    !url.pathname.startsWith(
      (chat.config().pathPrefix || '') + '/rails/active_storage/',
    )
  )
    throw new ServiceUnavailableException('附件来源无效');
  const r = await fetch(url, {
    headers: chat.gatewayHeaders(),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  let content = r;
  if (r.status === 302) {
    const location = r.headers.get('location');
    if (!location) throw new ServiceUnavailableException('附件跳转无效');
    const next = relayStorageRedirect(
      location,
      url,
      chat.config().pathPrefix || '',
    );
    content = await fetch(next, {
      headers: chat.gatewayHeaders(),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  }
  if (!content.ok) throw new ServiceUnavailableException('附件暂不可用');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content.body!) {
    if ((size += chunk.length) > 6 * 1024 * 1024)
      throw new ServiceUnavailableException('附件超出下载限制');
    chunks.push(chunk);
  }
  return {
    bytes: Buffer.concat(chunks),
    mime: content.headers.get('content-type') || 'application/octet-stream',
    name: relayFilename(file),
  };
}
