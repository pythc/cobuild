import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { User } from '@docmost/db/types/entity.types';
import { PageIdDto } from './dto/page.dto';
import { PageReadingService } from './services/page-reading.service';

@UseGuards(JwtAuthGuard)
@Controller('pages/reading')
export class PageReadingController {
  constructor(private readonly reading: PageReadingService) {}
  @Post() @HttpCode(200) @OAuthScope('read')
  recent(@AuthUser() user: User) { return this.reading.recent(user); }
  @Post('visit') @HttpCode(200) @OAuthScope('write')
  visit(@Body() dto: PageIdDto, @AuthUser() user: User) { return this.reading.visit(dto.pageId, user); }
}
