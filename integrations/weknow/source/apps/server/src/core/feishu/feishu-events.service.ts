import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import { FeishuDirectoryService } from './feishu-directory.service';

@Injectable()
export class FeishuEventsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private client?: WSClient;
  private logger = new Logger(FeishuEventsService.name);
  constructor(
    private config: ConfigService,
    private directory: FeishuDirectoryService,
  ) {}
  onApplicationBootstrap() {
    if (
      !this.directory.enabled ||
      this.config.get('FEISHU_EVENTS_ENABLED', 'false') !== 'true'
    )
      return;
    // SDK's default logs may include event bodies and URL tokens. Keep only
    // sanitized lifecycle messages; credentials never pass through our logger.
    this.client = new WSClient({
      appId: this.config.get('FEISHU_APP_ID'),
      appSecret: this.config.get('FEISHU_APP_SECRET'),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => this.logger.warn('Feishu event connection warning'),
        error: () => this.logger.warn('Feishu event connection unavailable'),
        trace: () => {},
      } as any,
      handshakeTimeoutMs: 12000,
      wsConfig: { pingTimeout: 60 },
    });
    const handlers: any = {};
    for (const type of [
      'contact.user.created_v3',
      'contact.user.updated_v3',
      'contact.user.deleted_v3',
      'contact.scope.updated_v3',
      'contact.department.created_v3',
      'contact.department.updated_v3',
      'contact.department.deleted_v3',
    ]) {
      handlers[type] = (event: any) => this.directory.receiveEvent(event, type);
    }
    void this.client
      .start({
        eventDispatcher: new EventDispatcher({
          logger: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            trace: () => {},
          } as any,
        }).register(handlers),
      })
      .catch(() => this.logger.warn('Feishu event connection unavailable'));
  }
  status() {
    return this.client?.getConnectionStatus().state || 'disabled';
  }
  onModuleDestroy() {
    this.client?.close({ force: true });
  }
}
