import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { NotificationDeliveryService, type ClaimedDelivery } from '../../modules/notifications/notification-delivery.service';
import { FeishuService, FeishuMessageDeliveryError } from '../../modules/requirements/feishu.service';
import { DevelopmentOverdueService } from '../../modules/notifications/development-overdue.service';

/** Uses the existing durable leases/receipts, replacing the hosted automation executor. */
@Injectable()
export class MakitNotificationWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly logger = new Logger(MakitNotificationWorker.name);
  constructor(private readonly deliveries: NotificationDeliveryService, private readonly feishu: FeishuService,
    private readonly overdue: DevelopmentOverdueService) {}
  onModuleInit() {
    if (process.env.MAKIT_WORKERS_ENABLED !== 'true') return;
    this.timer = setInterval(() => { void this.tick().catch(() => this.logger.error('notification_worker_failed')); }, 5000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async tick() {
    if (process.env.MAKIT_WORKERS_ENABLED !== 'true' || process.env.MAKIT_EXTERNAL_WRITES_ENABLED !== 'true' || this.busy) return;
    this.busy=true;
    try {
      await this.overdue.scan();
      // The owner name remains compatible with imported receipt rows. Only the
      // native worker runs after cutover; the legacy executor must be stopped.
      for (const item of await this.deliveries.claim('managed_bot',[],4)) await this.send(item);
    } finally { this.busy=false; }
  }
  private async send(item: ClaimedDelivery) {
    try {
      const receipt=await this.feishu.sendMessageWithReceipt(item.targetId,item.payload.receiveIdType,
        item.payload.type,item.payload.content,item.idempotencyKey);
      await this.deliveries.result({id:item.id,leaseToken:item.leaseToken,outcome:'sent',
        messageId:receipt.messageId,providerRequestId:receipt.providerRequestId});
    } catch(error) {
      // A missing send result is ambiguous. It must not become a blind retry.
      await this.deliveries.result({id:item.id,leaseToken:item.leaseToken,
        outcome:error instanceof FeishuMessageDeliveryError ? error.outcome : 'unknown',
        errorCode:error instanceof FeishuMessageDeliveryError ? error.errorCode : 'notification_result_unknown'});
    }
  }
}
