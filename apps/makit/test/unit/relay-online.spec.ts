import { ServiceUnavailableException } from '@nestjs/common';
import {
  ChatwootClient,
  readChatwootConfig,
  chatwootConfig,
} from '../../server/modules/relay/chatwoot-client';
import {
  RelayController,
  RelayDispatcher,
} from '../../server/modules/relay/relay.controller';
import type { RequirementsQueryService } from '../../server/modules/requirements/requirements-query.service';
import type { Request, Response as ExpressResponse } from 'express';
const config = {
  origin: 'https://relay.example.test',
  pathPrefix: '/__relay_chatwoot',
  gatewayToken: 'g'.repeat(48),
  accountId: 1,
  token: 't'.repeat(40),
  apps: {
    makit: {
      inboxId: 1,
      identifier: 'makit',
      hmacToken: 'h'.repeat(40),
      name: 'Makit',
    },
  },
  operators: { member: 1 },
};
const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  jest.restoreAllMocks();
});
test('production JSON config is validated without opening an arbitrary file', () => {
  process.env.RELAY_CHATWOOT_CONFIG_JSON = JSON.stringify(config);
  process.env.RELAY_CHATWOOT_CONFIG = '/not-used';
  expect(readChatwootConfig()).toEqual(config);
  process.env.RELAY_CHATWOOT_CONFIG_JSON = 'invalid';
  expect(() => readChatwootConfig()).toThrow(ServiceUnavailableException);
});
test.each(['/../outside', '//outside', '/a?key=secret'])(
  'gateway prefix rejects path escape %s',
  (pathPrefix) => {
    expect(chatwootConfig.safeParse({ ...config, pathPrefix }).success).toBe(
      false,
    );
  },
);
test('both authenticated and public contact APIs require the private gateway key', async () => {
  process.env.RELAY_CHATWOOT_CONFIG_JSON = JSON.stringify(config);
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  const client = new ChatwootClient();
  await client.request('/api/v1/profile');
  await client.request('/public/api/v1/inboxes/makit/contacts', {
    public: true,
    method: 'POST',
    body: { name: 'self-test' },
  });
  expect(fetcher.mock.calls[0][0].toString()).toBe(
    'https://relay.example.test/__relay_chatwoot/api/v1/profile',
  );
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
    'X-Relay-Gateway-Key': config.gatewayToken,
    'X-Relay-Chatwoot-Token': config.token,
  });
  expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
    'X-Relay-Gateway-Key': config.gatewayToken,
  });
  expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty(
    'X-Relay-Chatwoot-Token',
  );
  expect(fetcher.mock.calls[1][1]?.redirect).toBe('error');
});
test('native application prefix is removed before dispatch, while actor comes from SDK identity', async () => {
  const dispatch = jest.fn();
  const currentUser = jest
    .fn()
    .mockResolvedValue({ employeeId: 'actual-member' });
  const controller = new RelayController(
    { dispatch } as unknown as RelayDispatcher,
    { currentUser } as unknown as RequirementsQueryService,
  );
  const req = {
    method: 'GET',
    path: '/app/app_17b6pxwde0x/api/relay/profile',
    headers: {},
    userContext: { userId: 'sdk-user', userName: 'self' },
  } as unknown as Request;
  const res = {} as ExpressResponse;
  await controller.route(req, res, undefined);
  expect(dispatch).toHaveBeenCalledWith('/relay/profile', req, res, undefined, {
    employeeId: 'actual-member',
  });
  expect(currentUser).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'sdk-user' }),
  );
});
