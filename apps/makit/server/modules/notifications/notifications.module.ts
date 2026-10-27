import { Module } from '@nestjs/common';
import { RequirementsModule } from '../requirements/requirements.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsReadService } from './notifications-read.service';

@Module({
  imports: [RequirementsModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsReadService,
  ],
})
export class NotificationsModule {}
