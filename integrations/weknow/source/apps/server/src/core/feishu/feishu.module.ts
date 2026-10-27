import { Global, Module } from '@nestjs/common';
import { FeishuApiService } from './feishu-api.service';
import { FeishuDirectoryProvider } from './feishu-directory-provider';
import { FeishuDirectoryService } from './feishu-directory.service';
import { FeishuEventsService } from './feishu-events.service';
import { FeishuIntegrationController } from './feishu.controller';
import { FeishuNotificationService } from './feishu-notification.service';
import { PageAccessModule } from '../page/page-access/page-access.module';

@Global()
@Module({
  imports: [PageAccessModule],
  controllers: [FeishuIntegrationController],
  providers: [
    FeishuApiService,
    FeishuDirectoryProvider,
    FeishuDirectoryService,
    FeishuEventsService,
    FeishuNotificationService,
  ],
  exports: [FeishuDirectoryService, FeishuNotificationService,FeishuApiService],
})
export class FeishuIntegrationModule {}
