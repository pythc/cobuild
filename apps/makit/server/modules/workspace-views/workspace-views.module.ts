import { Module } from '@nestjs/common';
import { RequirementsModule } from '../requirements/requirements.module';
import { WorkspaceViewsController } from './workspace-views.controller';
import { WorkspaceViewsService } from './workspace-views.service';

@Module({
  imports: [RequirementsModule],
  controllers: [WorkspaceViewsController],
  providers: [WorkspaceViewsService],
})
export class WorkspaceViewsModule {}
