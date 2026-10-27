import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  JwtApiKeyPayload,
  JwtOAuthPayload,
  JwtPayload,
  JwtType,
} from '../dto/jwt-payload';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { SessionActivityService } from '../../session/session-activity.service';
import { FastifyRequest } from 'fastify';
import {
  extractBearerTokenFromHeader,
  isUserDisabled,
} from '../../../common/helpers';
import { ModuleRef } from '@nestjs/core';
import { NativeSessionService } from '../../session/native-session.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private logger = new Logger('JwtStrategy');

  constructor(
    private userRepo: UserRepo,
    private workspaceRepo: WorkspaceRepo,
    private userSessionRepo: UserSessionRepo,
    private sessionActivityService: SessionActivityService,
    private readonly environmentService: EnvironmentService,
    private moduleRef: ModuleRef,
    @InjectKysely() private db: Kysely<any>,
    private config: ConfigService,
    private nativeSessions: NativeSessionService,
  ) {
    super({
      jwtFromRequest: (req: FastifyRequest) => {
        if(req.headers.authorization!==undefined)return extractBearerTokenFromHeader(req);
        return req.cookies?.authToken;
      },
      ignoreExpiration: false,
      secretOrKey: environmentService.getAppSecret(),
      passReqToCallback: true,
    });
  }

  async validate(
    req: any,
    payload: JwtPayload | JwtApiKeyPayload | JwtOAuthPayload,
  ) {
    if (!payload.workspaceId) {
      throw new UnauthorizedException();
    }

    if (req.raw.workspaceId && req.raw.workspaceId !== payload.workspaceId) {
      throw new UnauthorizedException('Workspace does not match');
    }

    if (
      payload.type !== JwtType.ACCESS ||
      payload.identityProvider !== 'feishu' ||
      !payload.sessionId
    )
      throw new UnauthorizedException();
    const workspace = await this.workspaceRepo.findById(payload.workspaceId);

    if (!workspace) {
      throw new UnauthorizedException();
    }
    const user = await this.nativeSessions.validate(
      payload.sub,
      payload.workspaceId,
      payload.sessionId,
    );

    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    if ((payload as JwtPayload).sessionId) {
      const sessionId = (payload as JwtPayload).sessionId;
      const session = await this.userSessionRepo.findActiveById(sessionId);
      if (
        !session ||
        session.userId !== payload.sub ||
        session.workspaceId !== payload.workspaceId
      ) {
        throw new UnauthorizedException();
      }
      req.raw.sessionId = sessionId;
      this.sessionActivityService.trackActivity(
        sessionId,
        payload.sub,
        payload.workspaceId,
      );
    }

    return { user, workspace, authType: JwtType.ACCESS };
  }
}
