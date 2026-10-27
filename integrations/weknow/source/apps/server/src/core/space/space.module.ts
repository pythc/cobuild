import { PersonalSpaceService } from './services/personal-space.service';
import { Module } from '@nestjs/common';
import { SpaceService } from './services/space.service';
import { SpaceController } from './space.controller';
import { SpaceMemberService } from './services/space-member.service';
import { SpaceAccessSummaryService } from './services/space-access-summary.service';

@Module({
  imports: [],
  controllers: [SpaceController],
  providers: [PersonalSpaceService, SpaceService, SpaceMemberService, SpaceAccessSummaryService],
  exports: [SpaceService, SpaceMemberService],
})
export class SpaceModule {}
