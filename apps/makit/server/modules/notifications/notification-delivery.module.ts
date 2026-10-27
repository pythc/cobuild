import { Module } from '@nestjs/common';
import { ServiceRoleDatabaseModule } from '../../database/service-role-database.module';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationRetryService } from './notification-retry.service';

@Module({
  imports: [ServiceRoleDatabaseModule],
  providers: [
    NotificationDeliveryService,
    NotificationRetryService,
  ],
  exports: [NotificationDeliveryService, NotificationRetryService],
})
export class NotificationDeliveryModule {}
