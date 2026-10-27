import { Module } from '@nestjs/common';
import { PullRequestsModule } from '../pull-requests/pull-requests.module';
import { RequirementsMcpService } from '../requirements/requirements-mcp.service';
import { RequirementsModule } from '../requirements/requirements.module';
import { RequirementsOpenApiController } from '../requirements/requirements.openapi.controller';

@Module({
  imports: [RequirementsModule, PullRequestsModule],
  controllers: [RequirementsOpenApiController],
  providers: [RequirementsMcpService],
})
export class WorkspaceMcpModule {}
