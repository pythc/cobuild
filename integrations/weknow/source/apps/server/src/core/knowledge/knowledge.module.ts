import { OfficeModule } from '../office/office.module';
import { Global, Module } from '@nestjs/common';
import { KnowledgeOAuthService } from './knowledge-oauth.service';
import {
  KnowledgeOAuthController,
  KnowledgeDiscoveryController,
} from './knowledge-oauth.controller';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeDocumentService } from './knowledge-document.service';
import { KnowledgeNativeService } from './knowledge-native.service';
import { KnowledgeOperationService } from './knowledge-operation.service';
import { KnowledgeFileService } from './knowledge-file.service';
import { KnowledgeMailService } from './knowledge-mail.service';
import { KNOWLEDGE_ACCESS } from './knowledge-policy';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { PageAccessModule } from '../page/page-access/page-access.module';
import { AttachmentModule } from '../attachment/attachment.module';
import { FeishuIntegrationModule } from '../feishu/feishu.module';
@Global()
@Module({
  imports: [
    CollaborationModule,
    PageAccessModule,
    AttachmentModule,
    OfficeModule,
    FeishuIntegrationModule,
  ],
  controllers: [
    KnowledgeOAuthController,
    KnowledgeDiscoveryController,
    KnowledgeController,
  ],
  providers: [
    KnowledgeOAuthService,
    KnowledgeDocumentService,
    KnowledgeNativeService,
    KnowledgeOperationService,
    KnowledgeFileService,
    KnowledgeMailService,
    { provide: KNOWLEDGE_ACCESS, useExisting: KnowledgeNativeService },
  ],
  exports: [
    KnowledgeDocumentService,
    KnowledgeMailService,
    KnowledgeOAuthService,
    KNOWLEDGE_ACCESS,
  ],
})
export class KnowledgeModule {}
