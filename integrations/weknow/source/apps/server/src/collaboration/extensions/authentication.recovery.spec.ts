import { Server } from '@hocuspocus/server';
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticationExtension } from './authentication.extension';
import { CollabAuthRetry } from '../../../../client/src/features/editor/collab-auth-retry';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end)
      throw new Error('Collaboration recovery did not converge');
    await sleep(20);
  }
}

test('real Hocuspocus protocol recovers transient auth failures without losing queued edits or allowing revoked writes', async () => {
  let state: 'active' | 'unavailable' | 'revoked' = 'unavailable';
  const pageId = '4bfc474b-7ee3-4ff6-8f91-64091dc26803';
  const native = {
    validate: jest.fn(async () => {
      if (state === 'unavailable') throw new ServiceUnavailableException();
      if (state === 'revoked') throw new UnauthorizedException();
      return { id: 'user', workspaceId: 'workspace' };
    }),
  };
  const extension = new AuthenticationExtension(
    {
      verifyJwt: async () => ({
        sub: 'user',
        workspaceId: 'workspace',
        sessionId: 'session',
      }),
    } as any,
    native as any,
    {} as any,
    {
      findById: async () => ({
        id: pageId,
        workspaceId: 'workspace',
        spaceId: 'space',
      }),
    } as any,
    { getUserSpaceRoles: async () => [{ role: 'writer' }] } as any,
    {
      canUserEditPage: async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: true,
      }),
    } as any,
  );
  const server = new Server({ port: 0, quiet: true, extensions: [extension] });
  await server.listen();
  const port = (server.httpServer.address() as any).port;
  const document = new Y.Doc();
  const failures: string[] = [];
  let handshakes = 0;
  let closes: string[] = [];
  let provider: HocuspocusProvider;
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}`,
    WebSocketPolyfill: WebSocket,
    autoConnect: false,
  });
  const retry = new CollabAuthRetry(() => {
    void provider.sendToken().then(() => provider.startSync());
  });
  try {
    document.getMap('test').set('initial', 'local-before-first-auth');
    provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: `page.${pageId}`,
      token: 'isolated-test-token',
      document,
      onAuthenticationFailed: ({ reason }) => {
        failures.push(reason);
        retry.failed(reason);
      },
      onAuthenticated: () => {
        handshakes++;
        retry.reset();
      },
      onClose: ({ event }) => {
        closes.push(event.reason);
        retry.failed(event.reason);
      },
    });
    provider.attach();
    void socket.connect();
    await until(() => failures.includes('identity-unavailable'));
    expect(server.hocuspocus.documents.get(`page.${pageId}`)).toBeUndefined();
    state = 'active';
    await until(() => provider.synced && handshakes === 1);
    let remote = server.hocuspocus.documents.get(`page.${pageId}`)!;
    await until(
      () => remote.getMap('test').get('initial') === 'local-before-first-auth',
    );

    // Force the next message's inspection to fail. This update must not reach
    // the server while the identity provider cannot confirm authorization.
    state = 'unavailable';
    for (const connection of remote.getConnections())
      connection.context.nativeSession.nextCheck = 0;
    document.getMap('test').set('during-outage', 'retained-local-edit');
    await until(() => closes.includes('identity-unavailable'));
    expect(remote.getMap('test').get('during-outage')).toBeUndefined();
    state = 'active';
    await until(() => handshakes >= 2 && provider.synced);
    // Hocuspocus may unload a document after its last connection closes.
    remote = server.hocuspocus.documents.get(`page.${pageId}`)!;
    await until(
      () =>
        remote.getMap('test').get('during-outage') === 'retained-local-edit',
    );
    expect(remote.getMap('test').get('initial')).toBe(
      'local-before-first-auth',
    );

    state = 'revoked';
    for (const connection of remote.getConnections())
      connection.context.nativeSession.nextCheck = 0;
    document.getMap('test').set('after-revoke', 'must-not-be-applied');
    await until(() => closes.includes('Session expired'));
    expect(remote.getMap('test').get('after-revoke')).toBeUndefined();
    const confirmedHandshakes = handshakes;
    await sleep(2600);
    expect(handshakes).toBe(confirmedHandshakes);
    expect(remote.getMap('test').get('after-revoke')).toBeUndefined();
  } finally {
    retry.dispose();
    provider?.destroy();
    socket.destroy();
    extension.onModuleDestroy();
    await server.destroy();
    document.destroy();
  }
}, 25_000);
