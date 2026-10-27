import { FileIndexService } from './file-index.service';
import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { PublicSpaceModule } from '../public-space/public-space.module';

@Module({
  imports: [PublicSpaceModule],
  controllers: [SearchController],
  providers: [SearchService, FileIndexService],
  exports: [SearchService],
})
export class SearchModule {}
