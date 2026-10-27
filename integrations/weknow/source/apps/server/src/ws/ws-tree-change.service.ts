import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import * as postgres from 'postgres';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { normalizePostgresUrl } from '../common/helpers';
import { WsService } from './ws.service';

@Injectable()
export class WsTreeChangeService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WsTreeChangeService.name);
  private database: ReturnType<typeof postgres>;
  private retry?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  constructor(
    private readonly env: EnvironmentService,
    private readonly ws: WsService,
  ) {}

  async onApplicationBootstrap() {
    this.database = postgres(normalizePostgresUrl(this.env.getDatabaseURL()), {
      max: 1,
      onnotice: () => {},
      connect_timeout: 5,
    });
    await this.start();
  }
  private async start() {
    if (this.stopped) return;
    try {
      await this.database.listen(
        'weknow_page_tree',
        (value) => this.receive(value),
        () => {
          // Includes re-subscription after a database connection interruption.
          this.ws.notifyTreeChanged();
        },
      );
    } catch {
      if (!this.stopped) {
        this.logger.warn(
          'Page tree listener unavailable; retrying in 5 seconds',
        );
        this.retry = setTimeout(() => {
          void this.start();
        }, 5000);
        this.retry.unref();
      }
    }
  }
  private receive(value: string) {
    if (this.stopped || value.length > 100) return;
    let spaceId: string;
    try {
      spaceId = JSON.parse(value).spaceId;
    } catch {
      return;
    }
    if (
      typeof spaceId !== 'string' ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(spaceId)
    )
      return;
    if (this.pending.has(spaceId)) return;
    // A batch import can touch thousands of pages. Coalesce per-space commits.
    if (this.pending.size >= 1000) return;
    const timer = setTimeout(() => {
      this.pending.delete(spaceId);
      if (!this.stopped) this.ws.notifyTreeChanged(spaceId);
    }, 150);
    timer.unref();
    this.pending.set(spaceId, timer);
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.retry);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    await this.database?.end({ timeout: 2 });
  }
}
