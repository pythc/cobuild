import { NativeSessionService } from '../core/session/native-session.service';
import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../core/auth/services/token.service';
import { JwtPayload, JwtType } from '../core/auth/dto/jwt-payload';
import {
  HttpException,
  UnauthorizedException,
  OnModuleDestroy,
} from '@nestjs/common';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { WsService } from './ws.service';
import { getSpaceRoomName, getUserRoomName } from './ws.utils';
import { BaseRealtimeBridge } from './base-realtime.bridge';
import * as cookie from 'cookie';

@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket'],
})
export class WsGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  constructor(
    private tokenService: TokenService,
    private nativeSessions: NativeSessionService,
    private spaceMemberRepo: SpaceMemberRepo,
    private wsService: WsService,
    private baseRealtime: BaseRealtimeBridge,
  ) {}

  afterInit(server: Server): void {
    this.wsService.setServer(server);
    this.baseRealtime.setServer(server);
  }

  async handleConnection(client: Socket, ...args: any[]): Promise<void> {
    try {
      const cookies = cookie.parse(client.handshake.headers.cookie || '');
      const token: JwtPayload = await this.tokenService.verifyJwt(
        cookies['authToken'],
        JwtType.ACCESS,
      );

      if (token.identityProvider !== 'feishu')
        throw new UnauthorizedException('Legacy session');
      await this.nativeSessions.validate(
        token.sub,
        token.workspaceId,
        token.sessionId,
      );
      client.use(async (_packet, next) => {
        try {
          await this.nativeSessions.validate(
            token.sub,
            token.workspaceId,
            token.sessionId,
          );
          await this.refreshSpaceRooms(client, token.sub);
          next();
        } catch (error) {
          this.disconnectSession(client, error);

          next(new Error('Unauthorized'));
        }
      });
      client.data.sessionCheck = setInterval(async () => {
        try {
          await this.nativeSessions.validate(
            token.sub,
            token.workspaceId,
            token.sessionId,
          );
          await this.refreshSpaceRooms(client, token.sub);
        } catch (error) {
          this.disconnectSession(client, error);
        }
      }, 30000);
      client.data.sessionCheck.unref();
      const userId = token.sub;
      const workspaceId = token.workspaceId;

      client.data.userId = userId;
      client.data.workspaceId = workspaceId;

      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      const userRoom = getUserRoomName(userId);
      const workspaceRoom = `workspace-${workspaceId}`;
      const spaceRooms = userSpaceIds.map((id) => getSpaceRoomName(id));

      await client.join([userRoom, workspaceRoom, ...spaceRooms]);
      client.emit('Ready');
    } catch (err) {
      this.disconnectSession(client, err);
    }
  }

  private disconnectSession(client: Socket, error: unknown) {
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : error instanceof Error &&
            [
              'JsonWebTokenError',
              'TokenExpiredError',
              'NotBeforeError',
            ].includes(error.name)
          ? 401
          : 503;
    const temporary = status >= 500 || status === 429;
    client.emit(temporary ? 'SessionUnavailable' : 'Unauthorized');
    client.disconnect(true);
  }

  private async refreshSpaceRooms(client: Socket, userId: string) {
    const allowed = new Set(
      (await this.spaceMemberRepo.getUserSpaceIds(userId)).map((id) =>
        getSpaceRoomName(id),
      ),
    );
    for (const room of client.rooms)
      if (room.startsWith('space-') && !allowed.has(room))
        await client.leave(room);
    for (const room of allowed)
      if (!client.rooms.has(room)) await client.join(room);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    if (client.data.sessionCheck) clearInterval(client.data.sessionCheck);
    await this.baseRealtime.handleDisconnect(client);
  }

  @SubscribeMessage('message')
  async handleMessage(client: Socket, data: any): Promise<void> {
    if (this.wsService.isTreeEvent(data)) {
      await this.wsService.handleTreeEvent(client, data);
      return;
    }
    if (this.baseRealtime.isBaseEvent(data)) {
      await this.baseRealtime.handleInbound(client, data);
      return;
    }
  }

  /*
  @SubscribeMessage('join-room')
  handleJoinRoom(client: Socket, @MessageBody() roomName: string): void {
    // if room is a space, check if user has permissions
    //client.join(roomName);
  }

  @SubscribeMessage('leave-room')
  handleLeaveRoom(client: Socket, @MessageBody() roomName: string): void {
    client.leave(roomName);
  }
 */

  onModuleDestroy() {
    if (this.server) {
      this.server.close();
    }
  }
}
