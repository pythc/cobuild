import { Module } from '@nestjs/common';
import { ServiceRoleDatabaseModule } from '../../database/service-role-database.module';
import { GitHubPullRequestsService } from './github-pull-requests.service';
import { PullRequestRefreshCoordinatorService } from './pull-request-refresh-coordinator.service';
import { GitHubResourceCacheService } from './github-resource-cache.service';
import { GitHubSyncService } from './github-sync.service';
import { GitHubWebhookService } from './github-webhook.service';
import { GitHubWebhookController, GitHubWebhookRawBodyInstaller } from './github-webhook.openapi.controller';

@Module({
  imports: [ServiceRoleDatabaseModule],
  controllers: [GitHubWebhookController],
  providers: [
    GitHubPullRequestsService,
    PullRequestRefreshCoordinatorService,
    GitHubResourceCacheService,
    GitHubSyncService,
    GitHubWebhookService,
    GitHubWebhookRawBodyInstaller,
  ],
  exports: [
    GitHubPullRequestsService,
    PullRequestRefreshCoordinatorService,
  ],
})
export class GitHubPullRequestsModule {}
