import {
  relayStorageRedirect,
  downloadRelayAttachment,
} from '../../server/modules/relay/relay-chatwoot.attachment';
import type { ChatwootClient } from '../../server/modules/relay/chatwoot-client';
const source = new URL(
  'https://relay.example.test/__relay_chatwoot/rails/active_storage/blobs/redirect/signed/file.txt',
);
const prefix = '/__relay_chatwoot';
afterEach(() => jest.restoreAllMocks());
test('restores the protected proxy prefix for Rails origin-root storage redirects', () => {
  expect(
    relayStorageRedirect(
      '/rails/active_storage/disk/signed/file.txt?download=1',
      source,
      prefix,
    ).href,
  ).toBe(
    'https://relay.example.test/__relay_chatwoot/rails/active_storage/disk/signed/file.txt?download=1',
  );
  expect(
    relayStorageRedirect(
      prefix + '/rails/active_storage/disk/signed/file.txt',
      source,
      prefix,
    ).pathname,
  ).toBe(prefix + '/rails/active_storage/disk/signed/file.txt');
});
test.each([
  'https://outside.test/rails/active_storage/disk/file',
  'https://u:p@relay.example.test/rails/active_storage/disk/file',
  '/admin',
  '/rails/active_storage/../../admin',
])('rejects an unsafe redirect %s', (location) => {
  expect(() => relayStorageRedirect(location, source, prefix)).toThrow(
    '附件跳转无效',
  );
});
test('downloads bytes through both protected requests without leaking the API token', async () => {
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: '/rails/active_storage/disk/signed/file.txt' },
      }),
    )
    .mockResolvedValueOnce(
      new Response('attachment', { headers: { 'content-type': 'text/plain' } }),
    );
  const chat = {
    config: () => ({ origin: source.origin, pathPrefix: prefix }),
    gatewayHeaders: () => ({ 'X-Relay-Gateway-Key': 'test-key' }),
  } as unknown as ChatwootClient;
  const result = await downloadRelayAttachment(chat, {
    data_url: source.href,
    file_name: 'file.txt',
  });
  expect(result.bytes.toString()).toBe('attachment');
  expect(fetcher.mock.calls[1][0].toString()).toBe(
    'https://relay.example.test' +
      prefix +
      '/rails/active_storage/disk/signed/file.txt',
  );
  expect(fetcher.mock.calls[1][1]).toMatchObject({
    headers: { 'X-Relay-Gateway-Key': 'test-key' },
    redirect: 'error',
  });
});
