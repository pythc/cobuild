import { axiosForBackend } from '@/lib/selfhost-http';

/** Only our authenticated Relay resources may use the SDK transport. */
export function relayResourcePath(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  const path = url.pathname.replace(/^\/app\/[^/]+(?=\/api\/)/, '');
  if (
    !/^\/api\/relay\/(?:native-)?attachments\/[\w-]+\/\d+$/.test(path) &&
    !/^\/api\/workspace\/relay-context\/relay_v1:[a-f0-9]{64}$/.test(path)
  )
    return null;
  return path + url.search;
}

export async function relayResource(
  href: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const url = relayResourcePath(href, window.location.origin);
  if (!url) throw new Error('附件地址无效');
  try {
    const response = await axiosForBackend({
      url,
      method: 'GET',
      responseType: 'blob',
      signal,
    });
    if (!(response.data instanceof Blob)) throw new Error('附件响应无效');
    return response.data;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('附件读取失败，请重试');
  }
}

export async function downloadRelayResource(
  href: string,
  name: string,
): Promise<void> {
  const blob = await relayResource(href);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name.replace(/[\\/\u0000-\u001f]/g, '_') || 'relay-file';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
