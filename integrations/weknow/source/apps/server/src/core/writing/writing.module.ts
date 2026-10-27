import { Module, Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User } from '@docmost/db/types/entity.types';
import { WritingService } from './writing.service';
@Controller('writing')
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
class WritingController {
  constructor(private readonly writing: WritingService) {}
  @Get('weekly') weekly(@AuthUser() user: User) {
    return this.writing.weekly(user);
  }
}
@Module({ controllers: [WritingController], providers: [WritingService] })
export class WritingModule {}
