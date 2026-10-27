import { Module } from '@nestjs/common';
import { RequirementsModule } from '../requirements/requirements.module';
import { GitHubPullRequestsModule } from '../pull-requests/github-pull-requests.module';
import { OperationsAccessService } from './operations-access.service';
import { OperationsAdminsController } from './operations-admins.controller';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { OperationsNotificationsController } from './operations-notifications.controller';
import { OperationsNotificationsService } from './operations-notifications.service';

@Module({
  imports: [RequirementsModule, GitHubPullRequestsModule],
  controllers: [
    OperationsController,
    OperationsAdminsController,
    OperationsNotificationsController,
  ],
  providers: [
    OperationsService,
    OperationsAccessService,
    OperationsNotificationsService,
  ],
  exports: [OperationsAccessService],
})
export class OperationsModule {}
