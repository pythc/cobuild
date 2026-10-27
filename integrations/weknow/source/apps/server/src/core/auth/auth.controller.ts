import {
  Controller,
  Post,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AuthService } from './services/auth.service';
import { SessionService } from '../session/session.service';
@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(
    private authService: AuthService,
    private sessionService: SessionService,
  ) {}
  @Post('collab-token')
  @HttpCode(HttpStatus.OK)
  collabToken(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
  ) {
    return this.authService.getCollabToken(
      user,
      workspace.id,
      (req.raw as any).sessionId,
    );
  }
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @AuthUser() user: User,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const sessionId = (req.raw as any).sessionId;
    if (sessionId)
      await this.sessionService.revokeSession(
        sessionId,
        user.id,
        user.workspaceId,
      );
    res.clearCookie('authToken', { path: '/' });
  }
}
