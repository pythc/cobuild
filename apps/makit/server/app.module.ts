import { APP_FILTER } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PlatformModule } from '@lark-apaas/fullstack-nestjs-core';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { RequirementsModule } from './modules/requirements/requirements.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PullRequestsModule } from './modules/pull-requests/pull-requests.module';
import { WorkspaceMcpModule } from './modules/workspace-mcp/workspace-mcp.module';
import { ViewModule } from './modules/view/view.module';
import { OperationsModule } from './modules/operations/operations.module';
import { WorkspaceViewsModule } from './modules/workspace-views/workspace-views.module';
import { OperationsTelemetryModule } from './modules/operations/operations-telemetry.module';
import { OperationsInsightsModule } from './modules/operations/operations-insights.module';
import { NotificationDeliveryApiModule } from './modules/notifications/notification-delivery-api.module';

@Module({
  imports: [
    // 平台 Module，提供平台能力
    PlatformModule.forRoot(),
    // ====== @route-section: business-modules START ======
    RequirementsModule,
    NotificationsModule,
    PullRequestsModule,
    WorkspaceMcpModule,
    OperationsModule,
    WorkspaceViewsModule,
    OperationsTelemetryModule,
    OperationsInsightsModule,
    NotificationDeliveryApiModule,
    // ====== @route-section: business-modules END ======

    // ⚠️ @route-order: last
    // ViewModule is the fallback route module, must be registered last.
    ViewModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
