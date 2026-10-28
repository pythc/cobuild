import { NativeSessionService } from '../../core/session/native-session.service';
import { Extension, onAuthenticatePayload } from '@hocuspocus/server';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';
import { SpaceRole } from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { getPageId } from '../collaboration.util';
import { JwtCollabPayload, JwtType } from '../../core/auth/dto/jwt-payload';
import {
  IDENTITY_UNAVAILABLE,
  isTemporaryAuthFailure,
  temporaryAuthError,
} from './collaboration-auth-error';

@Injectable()
export class AuthenticationExtension implements Extension {
  private readonly logger = new Logger(AuthenticationExtension.name);
  private readonly sessionChecks = new Map<
    string,
    ReturnType<typeof setInterval>
  >();

  constructor(
    private tokenService: TokenService,
    private nativeSessions: NativeSessionService,
    private userRepo: UserRepo,
    private pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  async onAuthenticate(data: onAuthenticatePayload) {
    try {
      return await this.authenticate(data);
    } catch (error) {
      if (isTemporaryAuthFailure(error)) throw temporaryAuthError();
      throw error;
    }
  }

  private async authenticate(data: onAuthenticatePayload) {
    const { documentName, token } = data;
    const pageId = getPageId(documentName);

    let jwtPayload: JwtCollabPayload;

    try {
      jwtPayload = await this.tokenService.verifyJwt(token, JwtType.COLLAB);
    } catch (error) {
      throw new UnauthorizedException('Invalid collab token');
    }

    const userId = jwtPayload.sub;
    const workspaceId = jwtPayload.workspaceId;

    const user = await this.nativeSessions.validate(
      userId,
      workspaceId,
      jwtPayload.sessionId,
    );

    if (!user) {
      throw new UnauthorizedException();
    }

    if (isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    const page = await this.pageRepo.findById(pageId);
    if (!page || page.workspaceId !== workspaceId) {
      this.logger.debug(`Page not found: ${pageId}`);
      throw new NotFoundException('Page not found');
    }

    if (page.nodeType && page.nodeType !== 'page')
      throw new UnauthorizedException('该节点不使用文档编辑器');

    const userSpaceRoles = await this.spaceMemberRepo.getUserSpaceRoles(
      user.id,
      page.spaceId,
    );

    const userSpaceRole = findHighestUserSpaceRole(userSpaceRoles);

    if (!userSpaceRole) {
      this.logger.warn(`User not authorized to access page: ${pageId}`);
      throw new UnauthorizedException();
    }

    // Check page-level permissions
    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction) {
      if (!canAccess) {
        this.logger.warn(
          `User ${user.id} denied page-level access to page: ${pageId}`,
        );
        throw new UnauthorizedException();
      }

      if (!canEdit) {
        data.connectionConfig.readOnly = true;
        this.logger.debug(
          `User ${user.id} granted readonly access to restricted page: ${pageId}`,
        );
      }
    } else {
      // No restrictions - use space-level permissions
      if (userSpaceRole === SpaceRole.READER) {
        data.connectionConfig.readOnly = true;
        this.logger.debug(`User granted readonly access to page: ${pageId}`);
      }
    }

    if (page.deletedAt) {
      data.connectionConfig.readOnly = true;
    }

    this.logger.debug(`Authenticated user ${user.id} on page ${pageId}`);

    return {
      user,
      nativeSession: {
        userId,
        workspaceId,
        sessionId: jwtPayload.sessionId,
        pageId,
        nextCheck: 0,
      },
    };
  }
  async connected(data: any) {
    const session = data.context?.nativeSession;
    if (!session) return;
    const key = data.socketId + '|' + data.documentName;
    const previous = this.sessionChecks.get(key);
    if (previous) clearInterval(previous);
    const timer = setInterval(async () => {
      try {
        await this.refreshAuthorization(data);
      } catch (error) {
        this.closeAfterFailure(data, error);
      }
    }, process.env.COBUILD_IDENTITY_MODE === 'local' ? 5000 : 30000);
    timer.unref();
    this.sessionChecks.set(key, timer);
  }
  async onDisconnect(data: any) {
    const timer = this.sessionChecks.get(
      data.socketId + '|' + data.documentName,
    );
    if (timer) clearInterval(timer);
    this.sessionChecks.delete(data.socketId + '|' + data.documentName);
  }
  onModuleDestroy() {
    for (const timer of this.sessionChecks.values()) clearInterval(timer);
    this.sessionChecks.clear();
  }
  async beforeHandleMessage(data: any) {
    const session = data.context?.nativeSession;
    if (!session) throw new UnauthorizedException();
    if (process.env.COBUILD_IDENTITY_MODE === 'local' || Date.now() >= session.nextCheck) {
      try {
        await this.refreshAuthorization(data);
        session.nextCheck = Date.now() + 5000;
      } catch (error) {
        this.closeAfterFailure(data, error);
        // Reject the current update before Hocuspocus can apply it to the document.
        if (isTemporaryAuthFailure(error)) throw temporaryAuthError();
        throw error;
      }
    }
  }

  private closeAfterFailure(data: any, error: unknown) {
    const session = data.context?.nativeSession;
    if (session) session.nextCheck = 0;
    // Also block already queued writable messages while the close is processed.
    data.connection.readOnly = true;
    data.connection.close(
      isTemporaryAuthFailure(error)
        ? { code: 1013, reason: IDENTITY_UNAVAILABLE }
        : { code: 4401, reason: 'Session expired' },
    );
  }
  private async refreshAuthorization(data: any) {
    const session = data.context?.nativeSession;
    if (!session) throw new UnauthorizedException();
    const user = await this.nativeSessions.validate(
      session.userId,
      session.workspaceId,
      session.sessionId,
    );
    const page = await this.pageRepo.findById(session.pageId);
    if (!page || page.workspaceId !== session.workspaceId)
      throw new UnauthorizedException();
    const roles = await this.spaceMemberRepo.getUserSpaceRoles(
      user.id,
      page.spaceId,
    );
    const role = findHighestUserSpaceRole(roles);
    if (!role) throw new UnauthorizedException();
    const permissions = await this.pagePermissionRepo.canUserEditPage(
      user.id,
      page.id,
    );
    if (permissions.hasAnyRestriction && !permissions.canAccess)
      throw new UnauthorizedException();
    const readOnly =
      !!page.deletedAt ||
      (permissions.hasAnyRestriction
        ? !permissions.canEdit
        : role === SpaceRole.READER);
    if (data.connection && data.connection.readOnly !== readOnly) {
      data.connection.close({ code: 4403, reason: 'Permissions changed' });
      throw new UnauthorizedException();
    }
  }
}
