import { Module } from '@nestjs/common';
import { RequirementsModule } from '../requirements/requirements.module';
import { GitHubPullRequestsModule } from './github-pull-requests.module';
import { PullRequestsController } from './pull-requests.controller';
import { PullRequestsService } from './pull-requests.service';
import { NotificationDeliveryModule } from '../notifications/notification-delivery.module';

@Module({
  imports: [RequirementsModule, GitHubPullRequestsModule, NotificationDeliveryModule],
  controllers: [PullRequestsController],
  providers: [PullRequestsService],
  exports: [PullRequestsService],
})
export class PullRequestsModule {}
