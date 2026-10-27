import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { WsGateway } from './ws.gateway';
describe('socket identity failure classification', () => {
  afterEach(() => jest.useRealTimers());
  function fixture(error?: Error) {
    const validate = jest.fn();
    if (error) validate.mockRejectedValue(error);
    else validate.mockResolvedValue({});
    const client: any = {
      handshake: { headers: { cookie: 'authToken=fixture' } },
      rooms: new Set(),
      data: {},
      use: jest.fn(),
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    const gateway = new WsGateway(
      {
        verifyJwt: async () => ({
          identityProvider: 'feishu',
          sub: 'u',
          workspaceId: 'w',
          sessionId: 's',
        }),
      } as any,
      { validate } as any,
      { getUserSpaceIds: async () => [] } as any,
      {} as any,
      { handleDisconnect: async () => {} } as any,
    );
    return { client, gateway, validate };
  }
  test.each([new ServiceUnavailableException(), new Error('database offline')])(
    'transient failures allow reconnect without claiming authentication was revoked',
    async (error) => {
      const { client, gateway } = fixture(error);
      await gateway.handleConnection(client);
      expect(client.emit).toHaveBeenCalledWith('SessionUnavailable');
      expect(client.emit).not.toHaveBeenCalledWith('Unauthorized');
    },
  );
  test('real rejection requests session verification and does not label it as an outage', async () => {
    const { client, gateway } = fixture(new UnauthorizedException());
    await gateway.handleConnection(client);
    expect(client.emit).toHaveBeenCalledWith('Unauthorized');
    expect(client.emit).not.toHaveBeenCalledWith('SessionUnavailable');
  });
  test('signals readiness after joining rooms and handles a later inspection outage', async () => {
    jest.useFakeTimers();
    const { client, gateway, validate } = fixture();
    await gateway.handleConnection(client);
    expect(client.join).toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('Ready');
    validate.mockRejectedValue(new ServiceUnavailableException());
    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.emit).toHaveBeenCalledWith('SessionUnavailable');
    await gateway.handleDisconnect(client);
  });
});
