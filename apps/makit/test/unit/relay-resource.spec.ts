jest.mock('../../client/src/lib/selfhost-http', () => ({
  axiosForBackend: jest.fn(),
}));
import { axiosForBackend } from '../../client/src/lib/selfhost-http';
import {
  relayResourcePath,
  relayResource,
} from '../../client/src/components/relay/relay-resource';
const origin = 'https://test.feishuapp.com';
test('SDK attachment paths retain view and remove the platform app prefix', () => {
  expect(
    relayResourcePath(
      origin + '/app/app_test/api/relay/attachments/cw_1_1/1?view=customer',
      origin,
    ),
  ).toBe('/api/relay/attachments/cw_1_1/1?view=customer');
  expect(
    relayResourcePath('/api/relay/native-attachments/cw_1_1/1', origin),
  ).toBe('/api/relay/native-attachments/cw_1_1/1');
  const path = '/api/workspace/relay-context/relay_v1:' + 'a'.repeat(64);
  expect(relayResourcePath(path, origin)).toBe(path);
});
test.each([
  'https://other.test/api/relay/attachments/cw_1_1/1',
  'https://user:pass@test.feishuapp.com/api/relay/attachments/cw_1_1/1',
  '/api/workspace/profile',
  'javascript:alert(1)',
  'https://[invalid',
  '/api/relay/attachments/cw_1_1/1/extra',
])('does not send authenticated requests to unapproved resource %s', (href) => {
  expect(relayResourcePath(href, origin)).toBeNull();
});
test('binary reads use the existing SDK authentication and preserve cancellation', async () => {
  Object.defineProperty(globalThis, 'window', {
    value: { location: { origin } },
    configurable: true,
  });
  const blob = new Blob(['test']);
  const request = jest.mocked(axiosForBackend);
  request.mockResolvedValue({ data: blob });
  const signal = new AbortController().signal;
  await expect(
    relayResource('/api/relay/attachments/cw_1_1/1', signal),
  ).resolves.toBe(blob);
  expect(request).toHaveBeenCalledWith({
    url: '/api/relay/attachments/cw_1_1/1',
    method: 'GET',
    responseType: 'blob',
    signal,
  });
  request.mockRejectedValueOnce(new Error('403'));
  await expect(
    relayResource('/api/relay/attachments/cw_1_1/1'),
  ).rejects.toThrow('附件读取失败');
  delete (globalThis as { window?: unknown }).window;
});
