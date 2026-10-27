import { OfficeModule } from '../office/office.module';
import { Module } from '@nestjs/common';
import { PageService } from './services/page.service';
import { PageController } from './page.controller';
import { PageHistoryService } from './services/page-history.service';
import { TrashCleanupService } from './services/trash-cleanup.service';
import { BacklinkService } from './services/backlink.service';
import { StorageModule } from '../../integrations/storage/storage.module';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { WatcherModule } from '../watcher/watcher.module';
import { TransclusionModule } from './transclusion/transclusion.module';
import { LabelModule } from '../label/label.module';
import { PageReadingService } from './services/page-reading.service';
import { PageReadingController } from './page-reading.controller';

@Module({
  controllers: [PageController, PageReadingController],
  providers: [
    PageService,
    PageHistoryService,
    TrashCleanupService,
    BacklinkService,
    PageReadingService,
  ],
  exports: [PageService, PageHistoryService],
  imports: [
    StorageModule,
    OfficeModule,
    CollaborationModule,
    WatcherModule,
    TransclusionModule,
    LabelModule,
  ],
})
export class PageModule {}
