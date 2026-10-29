import {ProjectOverviewController} from '../../common/selfhost/project-overview.controller';
import { Module } from '@nestjs/common';
import { RequirementsModule } from '../requirements/requirements.module';
import { MakitSessionService } from '../../common/selfhost/session.service';
import { MakitAccessGuard } from '../../common/selfhost/access.guard';
import { MakitAuthController } from '../../common/selfhost/auth.controller';
import { MakitFilesController } from '../../common/selfhost/files.controller';
import { MakitDirectoryController } from '../../common/selfhost/directory.controller';
import { MakitOrganizationController } from '../../common/selfhost/organization.controller';
import { MakitOrganizationService } from '../../common/selfhost/organization.service';
import { MakitNotificationWorker } from '../../common/selfhost/notification-worker.service';
import { MakitIterationBotController } from '../../common/selfhost/iteration-bot.controller';
import { NotificationDeliveryModule } from '../notifications/notification-delivery.module';
import { NotificationDeliveryApiModule } from '../notifications/notification-delivery-api.module';

@Module({
  imports: [RequirementsModule, NotificationDeliveryModule, NotificationDeliveryApiModule], controllers: [ProjectOverviewController, MakitAuthController, MakitFilesController, MakitDirectoryController, MakitOrganizationController, MakitIterationBotController],
  providers: [MakitSessionService, MakitAccessGuard, MakitOrganizationService, MakitNotificationWorker], exports: [MakitSessionService, MakitAccessGuard],
})
export class MakitWebModule {}
