import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { FeishuService, type BaseRecord } from '../requirements/feishu.service';
import {
  people,
  textValue,
  timestamp,
} from '../requirements/requirements.model';
import { requirementPlatformUrl } from '../requirements/requirement-links';
import { NotificationDeliveryService } from './notification-delivery.service';
import {
  deliveryPolicy,
  type DeliveryPlan,
} from './notification-delivery.model';

/** One immutable notification per developer per entry into development. */
export function developmentOverduePlans(
  record: BaseRecord,
  now: number,
): DeliveryPlan[] {
  const f = record.fields;
  if (textValue(f['状态']) !== '开发中' || textValue(f['需求类型']) === '工单')
    return [];
  const start = timestamp(f['实际开始时间'] as string | number | null);
  const raw = f['工作量'];
  const effort =
    raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (
    !start ||
    !Number.isFinite(effort) ||
    effort < 0 ||
    !Number.isFinite(new Date(start).getTime()) ||
    !Number.isFinite(new Date(start + effort * 86400000).getTime()) ||
    now <= start + effort * 86400000
  )
    return [];
  const due = new Date(start + effort * 86400000).toISOString();
  const url = requirementPlatformUrl(record.record_id);
  const event =
    'development-overdue:' +
    createHash('sha256').update(`${record.record_id}:${start}`).digest('hex');
  const targets = new Map(
    people(f['研发人员']).map((person) => [person.id, person]),
  );
  return [...targets.values()]
    .filter((person) => /^ou_[A-Za-z0-9_-]+$/.test(person.id))
    .map((person) => {
      const policy = deliveryPolicy(
        'feishu_private',
        person.id,
        'requirement_workflow',
      );
      return {
        eventId: event,
        source: 'requirement_workflow',
        owner: 'managed_bot',
        kind: 'development_overdue',
        templateVersion: 'development-overdue-v1',
        requirementId: record.record_id,
        channel: 'feishu_private',
        targetId: person.id,
        targetName: person.name,
        platformUrl: url,
        policyMode: policy.mode,
        policyAllowed: policy.allowed,
        policyReason: policy.reason,
        payload: {
          type: 'post',
          receiveIdType: 'open_id',
          content: {
            zh_cn: {
              title: '需求开发超时',
              content: [
                [
                  {
                    tag: 'text',
                    text: `${textValue(f['需求编号']) || record.record_id} ${textValue(f['需求']) || '未命名需求'}`,
                  },
                ],
                [
                  {
                    tag: 'text',
                    text: `开发工作量：${effort} 个自然日；本轮开发开始：${new Date(start).toISOString()}；预计完成：${due}。请及时更新进展。`,
                  },
                ],
                [{ tag: 'a', text: '查看需求', href: url }],
              ],
            },
          },
        },
      };
    });
}

@Injectable()
export class DevelopmentOverdueService {
  private readonly logger = new Logger(DevelopmentOverdueService.name);
  private lastScan = 0;
  private running: Promise<void> | null = null;
  constructor(
    private readonly feishu: FeishuService,
    private readonly deliveries: NotificationDeliveryService,
  ) {}
  async scan(): Promise<void> {
    if (
      process.env.WORKFLOW_DELIVERY_OWNER !== 'managed_bot' ||
      process.env.DEVELOPMENT_OVERDUE_ENABLED === 'false'
    )
      return;
    if (this.running) return this.running;
    if (Date.now() - this.lastScan < 300000) return;
    const work = async () => {
      const table = process.env.FEISHU_REQUIREMENTS_TABLE;
      if (!table) throw new Error('Requirements table is not configured');
      const records = await this.feishu.listRecords(table, [
        '需求',
        '需求编号',
        '需求类型',
        '状态',
        '工作量',
        '实际开始时间',
        '研发人员',
      ]);
      for (const record of records) {
        for (const plan of developmentOverduePlans(record, Date.now()))
          await this.deliveries.record(plan, true);
      }
      this.lastScan = Date.now();
    };
    this.running = work()
      .catch(() => {
        this.lastScan = Date.now() - 240000;
        this.logger.warn('开发超时检查失败，下轮重试；已有通知队列继续处理');
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
