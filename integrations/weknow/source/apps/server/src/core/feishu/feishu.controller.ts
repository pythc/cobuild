import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { IsUUID } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User } from '@docmost/db/types/entity.types';
import { FeishuDirectoryService } from './feishu-directory.service';
import { FeishuEventsService } from './feishu-events.service';
import { FeishuNotificationService } from './feishu-notification.service';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
} from '../../integrations/throttle/throttler-names';

class MemberProfileDto {
  @IsUUID() userId: string;
}

@UseGuards(JwtAuthGuard)
@Controller('integrations/feishu')
export class FeishuIntegrationController {
  constructor(
    private directory: FeishuDirectoryService,
    private events: FeishuEventsService,
    private notifications: FeishuNotificationService,
    @InjectKysely() private db: Kysely<any>,
    private config: ConfigService,
  ) {}
  private admin(user: User) {
    if (!['owner', 'admin'].includes(user.role)) throw new ForbiddenException();
  }
  @Get('status') async status(@AuthUser() user: User) {
    this.admin(user);
    return {
      ...(await this.directory.status(user.workspaceId)),
      events: this.events.status(),
      notifications: await this.notifications.status(user.workspaceId),
    };
  }
  @Post('sync') @HttpCode(200) async sync(@AuthUser() user: User) {
    this.admin(user);
    return this.directory.sync('manual');
  }
  @Post('test-notification')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
  @Throttle({ [AUTH_THROTTLER]: { limit: 1, ttl: 60000 } })
  async testNotification(@AuthUser() user: User) {
    this.admin(user);
    return this.notifications.sendTest(user.id, user.workspaceId);
  }
  @Post('member') @HttpCode(200) async member(
    @AuthUser() user: User,
    @Body() dto: MemberProfileDto,
  ) {
    const member = await this.db
      .selectFrom('users as u')
      .innerJoin('feishuIdentities as f', 'f.userId', 'u.id')
      .select([
        'u.id',
        'u.name',
        'u.avatarUrl',
        'u.deletedAt',
        'u.deactivatedAt',
        'f.directoryStatus',
      ])
      .where('u.id', '=', dto.userId)
      .where('u.workspaceId', '=', user.workspaceId)
      .where('f.appId', '=', this.config.get('FEISHU_APP_ID', ''))
      .where('f.tenantKey', '=', this.config.get('FEISHU_TENANT_KEY', ''))
      .executeTakeFirst();
    return member
      ? {
          id: member.id,
          name: member.name,
          avatarUrl: member.avatarUrl,
          active:
            !member.deletedAt &&
            !member.deactivatedAt &&
            member.directoryStatus === 'active',
        }
      : null;
  }
}
