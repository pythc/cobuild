import { TemplateImagesService } from './template-images.service';
import { StorageModule } from '../../integrations/storage/storage.module';
import { Module } from '@nestjs/common';
import { DocumentTemplateController } from './template.controller';
import { DocumentTemplateService } from './template.service';
import { PageModule } from '../page/page.module';
import { PageAccessModule } from '../page/page-access/page-access.module';
import { CaslModule } from '../casl/casl.module';
@Module({
  imports: [PageModule, PageAccessModule, CaslModule, StorageModule],
  controllers: [DocumentTemplateController],
  providers: [DocumentTemplateService, TemplateImagesService],
})
export class DocumentTemplateModule {}
