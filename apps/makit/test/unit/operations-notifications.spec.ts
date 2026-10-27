import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import { OperationsNotificationsService } from '../../server/modules/operations/operations-notifications.service';
import { OperationsNotificationsController } from '../../server/modules/operations/operations-notifications.controller';
import { FeishuService } from '../../server/modules/requirements/feishu.service';

function workflowRow(id: string, source: string = '服务监听') {
  return {
    record_id: id,
    fields: {
      触发来源: source,
      事件类型: '需求变更',
      需求: [{ record_ids: ['rec1'] }],
      状态: '失败',
      尝试次数: 2,
      错误信息: '发送失败',
      负载摘要: '状态',
      更新时间: '2026-09-12T00:00:00Z',
    },
  };
}

describe('Operations workflow notifications', () => {
  it('reads one bounded projection, never labels platform history as delivered', async () => {
    const searchRecordPage = jest.fn().mockResolvedValue({
      items: [
        workflowRow('history', '需求协作平台'),
        workflowRow('first'),
        workflowRow('second'),
      ],
      hasMore: true,
    });
    const service = new OperationsNotificationsService(
      { searchRecordPage } as never,
      { table: () => 'collaboration' } as never,
    );
    const result = await service.list(2, 1);
    expect(searchRecordPage).toHaveBeenCalledTimes(1);
    expect(searchRecordPage.mock.calls[0][1]).toEqual({
      conjunction: 'and',
      conditions: [
        { fieldName: '触发来源', operator: 'is', value: ['服务监听'] },
      ],
    });
    expect(searchRecordPage.mock.calls[0][3]).toBe(500);
    expect(result.items.map((row) => row.id)).toEqual(['second']);
    expect(result.total).toBe(2);
    expect(result.items[0]).toMatchObject({
      attempts: 2,
      status: '失败',
      errorMessage: '依赖服务处理异常，请凭操作编号联系管理员排查。',
    });
    expect(result.coverageNote).toContain('最近 500 条');
    expect(result.coverageNote).toContain('不代表每位收件人');
  });

  it('returns safe event summaries and categorized errors, never provider payloads or credentials', async () => {
    const row = workflowRow('private-event');
    row.fields.错误信息 =
      '503 provider payload Authorization: Bearer do-not-expose';
    row.fields.负载摘要 = 'private PRD body and api_key=do-not-expose';
    row.fields.事件类型 = 'do-not-expose';
    row.fields.状态 = 'do-not-expose';
    const searchRecordPage = jest
      .fn()
      .mockResolvedValue({ items: [row], hasMore: false });
    const service = new OperationsNotificationsService(
      { searchRecordPage } as never,
      { table: () => 'collaboration' } as never,
    );
    const result = await service.list(1, 25);
    expect(result.items[0]).toMatchObject({
      eventType: '工作流',
      status: '未知',
      summary: '工作流通知事件',
      errorMessage: '未能确认最终结果，请先查看最新值，避免重复提交。',
    });
    expect(JSON.stringify(result)).not.toContain('do-not-expose');
    expect(searchRecordPage.mock.calls[0][2]).not.toContain('负载摘要');
  });

  it('marks the protected response private and non-cacheable', () => {
    expect(
      Reflect.getMetadata(
        HEADERS_METADATA,
        OperationsNotificationsController.prototype.list,
      ),
    ).toContainEqual({ name: 'Cache-Control', value: 'private, no-store' });
  });

  it('does not convert failed reads into a successful empty list', async () => {
    const service = new OperationsNotificationsService(
      {
        searchRecordPage: jest
          .fn()
          .mockRejectedValue(new Error('upstream unavailable')),
      } as never,
      { table: () => 'collaboration' } as never,
    );
    await expect(service.list(1, 25)).rejects.toThrow('upstream unavailable');
  });

  it('checks the live permission before reading; rejected requests have no data access', async () => {
    const access = {
      assertGlobal: jest.fn().mockRejectedValue(new ForbiddenException()),
    };
    const notifications = { list: jest.fn() };
    const controller = new OperationsNotificationsController(
      access as never,
      notifications as never,
    );
    await expect(controller.list({} as Request)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(notifications.list).not.toHaveBeenCalled();
  });

  it('validates pagination and caps page size without changing status', async () => {
    const notifications = { list: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new OperationsNotificationsController(
      {
        assertGlobal: jest.fn().mockResolvedValue({ canViewAll: true }),
      } as never,
      notifications as never,
    );
    await expect(controller.list({} as Request, 'NaN')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await controller.list({} as Request, '3', '999');
    expect(notifications.list).toHaveBeenCalledWith(3, 100);
  });

  it('Base projection uses a single search request and does not follow page tokens', async () => {
    const service = new FeishuService();
    const request = jest.fn().mockResolvedValue({
      items: [],
      has_more: true,
      page_token: 'never-follow',
    });
    Object.assign(service, { request, baseToken: () => 'base' });
    const result = await service.searchRecordPage(
      'table',
      {
        conjunction: 'and',
        conditions: [
          { fieldName: '触发来源', operator: 'is', value: ['服务监听'] },
        ],
      },
      ['状态'],
      9_999,
    );
    expect(result).toEqual({ items: [], hasMore: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][2]).toMatchObject({
      params: { page_size: 500 },
      data: {
        field_names: ['状态'],
        sort: [{ field_name: '创建时间', desc: true }],
      },
      retryableRead: true,
    });
  });
});
