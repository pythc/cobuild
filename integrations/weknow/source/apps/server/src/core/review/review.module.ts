import { Module } from '@nestjs/common';
import { ReviewService } from './review.service';
import { ReviewController } from './review.controller';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
@Module({
  imports: [CollaborationModule, KnowledgeModule],
  providers: [ReviewService],
  controllers: [ReviewController],
})
export class ReviewModule {}
