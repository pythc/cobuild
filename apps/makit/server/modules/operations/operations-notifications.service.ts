import { Injectable } from '@nestjs/common';
import type {
  WorkflowNotificationListResponse,
  WorkflowNotificationRecord,
} from '@shared/api.interface';
import { FeishuService, type BaseRecord } from '../requirements/feishu.service';
import { RequirementsQueryService } from '../requirements/requirements-query.service';
import {
  linkedIds,
  textValue,
  timestamp,
} from '../requirements/requirements.model';
import { safeOperationError } from './operations.model';

const WORKFLOW_WINDOW_SIZE: number = 500;
const WORKFLOW_FIELDS: string[] = [
  '事件类型',
  '需求',
  '状态',
  '触发来源',
  '尝试次数',
  '错误信息',
  '处理时间',
  '创建时间',
  '更新时间',
];
const WORKFLOW_EVENT_TYPES: ReadonlySet<string> = new Set([
  '需求新增',
  '需求变更',
]);
const WORKFLOW_EVENT_STATUSES: ReadonlySet<string> = new Set([
  '待处理',
  '处理中',
  '失败',
  '已发送',
  '已忽略',
]);

@Injectable()
export class OperationsNotificationsService {
  constructor(
    private readonly feishu: FeishuService,
    private readonly requirements: RequirementsQueryService,
  ) {}

  async list(
    page: number,
    pageSize: number,
  ): Promise<WorkflowNotificationListResponse> {
    const result = await this.feishu.searchRecordPage(
      this.requirements.table('FEISHU_COLLABORATION_TABLE'),
      {
        conjunction: 'and',
        conditions: [
          { fieldName: '触发来源', operator: 'is', value: ['服务监听'] },
        ],
      },
      WORKFLOW_FIELDS,
      WORKFLOW_WINDOW_SIZE,
    );
    // Keep a defensive source check: platform history marked “已完成” is not
    // proof that a notification was delivered by the independent bot.
    const rows: BaseRecord[] = result.items
      .filter(
        (row: BaseRecord): boolean =>
          textValue(row.fields['触发来源']) === '服务监听',
      )
      .slice(0, WORKFLOW_WINDOW_SIZE);
    const items: WorkflowNotificationRecord[] = rows
      .slice((page - 1) * pageSize, page * pageSize)
      .map((row: BaseRecord): WorkflowNotificationRecord => {
        const updated: number | null = timestamp(
          row.fields['处理时间'] ||
            row.fields['更新时间'] ||
            row.fields['创建时间'],
        );
        const attempts: number = Number(row.fields['尝试次数']);
        const rawEventType: string = textValue(row.fields['事件类型']);
        const eventType: string = WORKFLOW_EVENT_TYPES.has(rawEventType)
          ? rawEventType
          : '工作流';
        const rawStatus: string = textValue(row.fields['状态']);
        return {
          id: row.record_id,
          requirementIds: linkedIds(row.fields['需求']),
          eventType,
          source: '服务监听',
          status: WORKFLOW_EVENT_STATUSES.has(rawStatus) ? rawStatus : '未知',
          attempts: Number.isFinite(attempts)
            ? Math.max(0, Math.trunc(attempts))
            : 0,
          errorMessage: safeOperationError(textValue(row.fields['错误信息'])),
          summary: `${eventType}通知事件`,
          updatedAt: updated ? new Date(updated).toISOString() : null,
        };
      });
    return {
      items,
      total: rows.length,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(rows.length / pageSize)),
      coverageNote: `${result.hasMore ? '仅展示最近 500 条' : '展示当前'}工作流通知事件；状态来自周催办的事件级记录，不代表每位收件人均已送达或已读。需求修改记录与通知事件尚未逐项关联。`,
    };
  }
}
