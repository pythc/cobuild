import {ProjectActionService} from './project-action.service';
import {RelayNativeController} from '../relay/relay-native.controller';
import { RelayController, RelayDispatcher } from '../relay/relay.controller';
import { RelayChatwootService } from '../relay/relay-chatwoot.service';
import { RelayChatwootStore } from '../relay/relay-chatwoot.store';
import { ChatwootClient } from '../relay/chatwoot-client';
import {
  RelayContextController,
  RelayIntakeController,
} from './relay-intake.controller';
import { RelayIntakeService } from './relay-intake.service';
import { RelayIntakeStore } from './relay-intake.store';
import { PortalProjectService } from './portal-project.service';
import { PortalProjectOpenApiController } from './portal-project.openapi.controller';
import {
  LabIdentityController,
  LabIdentityOpenApiController,
} from './lab-identity.controller';
import { LabIdentityService } from './lab-identity.service';
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { FeishuService } from './feishu.service';
import { McpPersonalTokenService } from './mcp-personal-token.service';
import { RequirementsCommandService } from './requirements-command.service';
import { RequirementsController } from './requirements.controller';
import { RequirementsQueryService } from './requirements-query.service';
import { RequirementUpdateJobsService } from './requirement-update-jobs.service';
import { RequirementAccessService } from './requirement-access.service';
import { RequirementArchiveService } from './requirement-archive.service';
import { RequirementReleaseReadinessService } from './requirement-release-readiness.service';
import { RequirementPlatformRoleService } from './requirement-platform-role.service';
import { GitHubPullRequestsModule } from '../pull-requests/github-pull-requests.module';
import { RequirementAiReviewService } from './requirement-ai-review.service';
import { IterationConfigurationStore } from './iteration-configuration.store';
import { IterationSettingsService } from './iteration-settings.service';
import { RequirementDetailSectionsController } from './requirement-detail-sections.controller';
import { RequirementOperationOutboxService } from './requirement-operation-outbox.service';
import { RequirementBatchController } from './requirement-batch.controller';
import { RequirementBatchService } from './requirement-batch.service';
import { RequirementOperationRecoveryController } from './requirement-operation-recovery.controller';
import { NotificationDeliveryModule } from '../notifications/notification-delivery.module';

@Module({
  imports: [
    NotificationDeliveryModule,
    GitHubPullRequestsModule,
    HttpModule.register({ timeout: 90_000, maxRedirects: 0 }),
  ],
  controllers: [
    RelayNativeController,
    RelayController,
    RelayIntakeController,
    RelayContextController,
    PortalProjectOpenApiController,
    LabIdentityController,
    LabIdentityOpenApiController,
    RequirementsController,
    RequirementDetailSectionsController,
    RequirementBatchController,
    RequirementOperationRecoveryController,
  ],
  providers: [
    RelayDispatcher,
    RelayChatwootService,
    RelayChatwootStore,
    ChatwootClient,
    RelayIntakeService,
    RelayIntakeStore,
    PortalProjectService,
    ProjectActionService,
    LabIdentityService,
    RequirementBatchService,
    RequirementOperationOutboxService,
    IterationConfigurationStore,
    IterationSettingsService,
    FeishuService,
    RequirementsQueryService,
    RequirementsCommandService,
    RequirementUpdateJobsService,
    McpPersonalTokenService,
    RequirementAccessService,
    RequirementArchiveService,
    RequirementReleaseReadinessService,
    RequirementPlatformRoleService,
    RequirementAiReviewService,
  ],
  exports: [
    PortalProjectService,
    LabIdentityService,
    RequirementUpdateJobsService,
    RequirementPlatformRoleService,
    FeishuService,
    McpPersonalTokenService,
    RequirementsCommandService,
    RequirementsQueryService,
    RequirementAccessService,
    RequirementArchiveService,
    RequirementReleaseReadinessService,
    RequirementAiReviewService,
  ],
})
export class RequirementsModule {}
