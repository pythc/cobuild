import { Global, Module } from '@nestjs/common';
import { RequestContextService } from '../../common/selfhost/context';
import { DrizzleDatabaseManager, DRIZZLE_DATABASE, DATAPAAS_CONFIG } from '../../common/selfhost/database';
import { AuthNPaasService, PlatformHttpClientService, AuthorizationSDK } from '../../common/selfhost/platform';
import { WorkspaceRecordStore, WORKSPACE_SQL } from '../../database/workspace-record.store';
import { MakitIdentityRepository } from '../../common/selfhost/identity.repository';

@Global()
@Module({
  providers: [RequestContextService, DrizzleDatabaseManager, AuthNPaasService,
    PlatformHttpClientService, AuthorizationSDK, WorkspaceRecordStore, MakitIdentityRepository,
    { provide: DRIZZLE_DATABASE, inject: [DrizzleDatabaseManager], useFactory: (manager: DrizzleDatabaseManager) => manager.getDatabase() },
    { provide: WORKSPACE_SQL, inject: [DrizzleDatabaseManager], useFactory: (manager: DrizzleDatabaseManager) => manager.client },
    { provide: DATAPAAS_CONFIG, useValue: { connectionString: '', roleSchema: 'public' } },
  ],
  exports: [RequestContextService, DrizzleDatabaseManager, AuthNPaasService,
    PlatformHttpClientService, AuthorizationSDK, WorkspaceRecordStore, MakitIdentityRepository, DRIZZLE_DATABASE, WORKSPACE_SQL, DATAPAAS_CONFIG],
})
export class SelfhostPlatformModule {}
