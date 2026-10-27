import { Module } from '@nestjs/common';
import { OperationsModule } from './operations.module';
import { RequirementsModule } from '../requirements/requirements.module';
import { OperationsInsightsService } from './operations-insights.service';
import { OperationsInsightsController } from './operations-insights.openapi.controller';
import { IterationEfficiencyService } from './iteration-efficiency.service';
import { IterationEfficiencyController } from './iteration-efficiency.controller';

@Module({
  imports: [OperationsModule, RequirementsModule],
  controllers: [OperationsInsightsController, IterationEfficiencyController],
  providers: [OperationsInsightsService, IterationEfficiencyService],
})
export class OperationsInsightsModule {}
