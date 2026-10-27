import { Global, Module } from '@nestjs/common';
import { OperationsSettingsService } from './operations-settings.service';
import { OperationsTelemetryService } from './operations-telemetry.service';
import { ServiceRoleDatabaseModule } from '../../database/service-role-database.module';

@Global()
@Module({
  imports: [ServiceRoleDatabaseModule],
  providers: [
    OperationsSettingsService,
    OperationsTelemetryService,
  ],
  exports: [
    OperationsSettingsService,
    OperationsTelemetryService,
  ],
})
export class OperationsTelemetryModule {}
