import {Global, Module} from '@nestjs/common';
import {ServiceRoleDatabaseExecutor} from './service-role-database.executor';

@Global()
@Module({providers:[ServiceRoleDatabaseExecutor],exports:[ServiceRoleDatabaseExecutor]})
export class ServiceRoleDatabaseModule {}
