import { Module } from '@nestjs/common';
import { OfficeService } from './office.service';
import { OfficeController } from './office.controller';
import { StorageModule } from '../../integrations/storage/storage.module';
import { PageAccessModule } from '../page/page-access/page-access.module';
@Module({
  imports: [StorageModule, PageAccessModule],
  providers: [OfficeService],
  controllers: [OfficeController],
  exports: [OfficeService],
})
export class OfficeModule {}
