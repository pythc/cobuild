import { DevelopmentOverdueService } from './development-overdue.service';
import { Module } from '@nestjs/common';
import { RequirementsModule } from '../requirements/requirements.module';
import { NotificationDeliveryModule } from './notification-delivery.module';
import { ServiceRoleDatabaseModule } from '../../database/service-role-database.module';
import { WorkflowSourceService } from './workflow-source.service';
import {
  NotificationDeliveryController,
  WorkflowDeliveryController,
} from './notification-delivery.openapi.controller';

@Module({
  imports: [NotificationDeliveryModule, RequirementsModule, ServiceRoleDatabaseModule],
  providers: [WorkflowSourceService, DevelopmentOverdueService],
  controllers: [NotificationDeliveryController, WorkflowDeliveryController],
  exports: [DevelopmentOverdueService],
})
export class NotificationDeliveryApiModule {}
