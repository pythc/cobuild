import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import type { CurrentUserSummary } from '@shared/api.interface';
import { RequirementsCommandService } from './requirements-command.service';
import { RequirementsQueryService } from './requirements-query.service';
import { PortalProjectService } from './portal-project.service';
import { FeishuService, FeishuRequestError } from './feishu.service';
import { RelayIntakeStore, type IntakeRow } from './relay-intake.store';
import {
  intakeDigest,
  relayIntroduction,
  relayMarker,
  relayTicketInput,
} from './relay-intake.model';
import { TICKET_STATUSES } from '../../../shared/ticket-workflow';
import { requirementPlatformUrl } from './requirement-links';
import { textValue } from './requirements.model';
@Injectable()
export class RelayIntakeService {
  constructor(
    private readonly store: RelayIntakeStore,
    private readonly command: RequirementsCommandService,
    private readonly query: RequirementsQueryService,
    private readonly projects: PortalProjectService,
    private readonly feishu: FeishuService,
  ) {}
  private settings() {
    if (process.env.RELAY_INTEGRATION_ENABLED !== 'true')
      throw new ServiceUnavailableException('Relay 接入尚未启用');
    const source = process.env.RELAY_SOURCE_ID || '';
    const projectId = process.env.RELAY_PROJECT_ID || '';
    if (
      !/^[\w-]{1,120}$/.test(source) ||
      !z.uuid().safeParse(projectId).success
    )
      throw new ServiceUnavailableException('Relay 来源或工单项目未配置');
    let origin: string;
    try {
      origin = new URL(process.env.RELAY_PUBLIC_ORIGIN || '').origin;
    } catch {
      throw new ServiceUnavailableException('Relay 地址未配置');
    }
    if (
      !origin.startsWith('https://') &&
      !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
    )
      throw new ServiceUnavailableException('Relay 地址必须使用 HTTPS');
    const nativeOrigin = process.env.RELAY_NATIVE_PUBLIC_ORIGIN || '';
    if (nativeOrigin) {
      const native = new URL(nativeOrigin);
      if (native.protocol !== 'https:' || native.origin !== nativeOrigin)
        throw new ServiceUnavailableException('独立 Relay 地址配置无效');
    }
    return { source, projectId, origin, nativeOrigin };
  }
  async prepare() {
    const settings = this.settings();
    const fields = await this.feishu.listFields(
      this.query.table('FEISHU_REQUIREMENTS_TABLE'),
    );
    const needs: string[] = [];
    if (fields.find((f) => f.name === 'Relay 会话标识')?.type !== '1')
      needs.push('新增文本字段：Relay 会话标识');
    const options = (name: string) =>
      fields.find((f) => f.name === name)?.options.map((o) => o.name) || [];
    if (!options('需求类型').includes('工单')) needs.push('需求类型增加：工单');
    const missing = TICKET_STATUSES.filter((s) => !options('状态').includes(s));
    if (missing.length) needs.push('状态增加：' + missing.join('、'));
    if (!options('项目').includes('工单')) needs.push('项目增加：工单');
    if (needs.length) throw new ServiceUnavailableException(needs.join('；'));
    const existing = (
      await this.projects.lookup({ sourceProjectId: settings.projectId })
    ).project;
    if (existing && existing.projectName !== '工单')
      throw new ConflictException('配置的项目 ID 已用于其他项目');
    if (!existing)
      throw new ServiceUnavailableException(
        '请先通过现有项目同步登记工单项目，并配置其真实项目 UUID',
      );
    const project = existing;
    return { sourceId: settings.source, project };
  }
  async members(actor: CurrentUserSummary) {
    this.settings();
    const summary = await this.query.workspaceSummaryAs(actor, false);
    const ids = [
      ...new Set(
        Object.values(summary.peopleOptions)
          .flat()
          .map((p) => p.id),
      ),
    ];
    if (ids.length > 500)
      throw new ServiceUnavailableException(
        '成员目录较大，请先在需求平台分派处理人',
      );
    const members = new Map([
      [
        actor.employeeId,
        { id: actor.employeeId, name: actor.name, isCurrent: true },
      ],
    ]);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        for (;;) {
          const id = ids[cursor++];
          if (!id) return;
          if (id === actor.openId) continue;
          const p = await this.feishu.getUserByOpenId(id);
          if (!p.employeeId || p.openId !== id || !p.name)
            throw new ServiceUnavailableException('成员身份映射尚未确认');
          if (!members.has(p.employeeId))
            members.set(p.employeeId, {
              id: p.employeeId,
              name: p.name,
              isCurrent: false,
            });
        }
      }),
    );
    return { members: [...members.values()] };
  }
  async create(body: unknown, actor: CurrentUserSummary) {
    const settings = this.settings();
    const parsed = relayTicketInput.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('工单内容格式无效或超出限制');
    const input = parsed.data;
    if (
      ![settings.origin, settings.nativeOrigin].includes(
        new URL(input.sourceUrl).origin,
      )
    )
      throw new BadRequestException('咨询来源地址不匹配');
    let introduction: string;
    try {
      const base = requirementPlatformUrl('context-placeholder').replace(
        /\/requirements\/context-placeholder$/,
        '',
      );
      introduction = relayIntroduction(
        input,
        base +
          '/api/workspace/relay-context/' +
          relayMarker(settings.source, input.conversationId),
      );
    } catch {
      throw new BadRequestException('对话超过需求介绍上限，请使用附件链接');
    }
    await this.prepare();
    const { row, claimed } = await this.store.reserve(
      settings.source,
      input.conversationId,
      relayMarker(settings.source, input.conversationId),
      intakeDigest(input),
      JSON.stringify(input),
      actor.miaodaUserId,
    );
    if (!claimed) {
      if (row.state === 'linked') return this.result(row, actor);
      if (row.payload_hash !== intakeDigest(input))
        throw new ConflictException(
          '同一咨询已有不同的建单请求，请先查询原请求',
        );
      if (['writing', 'unknown'].includes(row.state))
        return this.reconcile(row, actor);
      throw new ConflictException('正在创建工单，请查询结果');
    }
    let writing = false;
    try {
      await this.command.createRequirementAs(
        {
          title: input.title,
          introduction,
          type: '工单',
          project: '工单',
          priority: input.priority,
          handlerLarkUserIds: input.handlerLarkUserIds,
          iterationIds: [],
        },
        actor,
        {
          marker: row.marker,
          beforeWrite: async () => {
            await this.store.writing(row);
            writing = true;
          },
          confirmed: async (record) => {
            await this.store.finish(row, record.record_id);
          },
        },
      );
    } catch (error) {
      // Keep uncertain remote writes fenced; a rejected request or validation error is safe to retry.
      const rejected =
        !writing ||
        (error instanceof FeishuRequestError && error.remoteRejected);
      await this.store.fail(
        row,
        rejected ? 'failed' : 'unknown',
        rejected ? 'create_rejected' : 'create_result_unknown',
      );
      if (writing && rejected)
        throw new BadRequestException(
          '需求平台拒绝建单，请核对处理人及表单配置后重试',
        );
      throw error;
    }
    const confirmed = await this.store.read(
      settings.source,
      input.conversationId,
    );
    if (!confirmed) throw new ServiceUnavailableException('建单关联读取失败');
    return this.result(confirmed, actor);
  }
  private async result(
    row: IntakeRow,
    actor: CurrentUserSummary,
    includeContext = true,
  ) {
    if (!row.requirement_id)
      throw new ConflictException('建单结果仍在核对，请稍后查询');
    const requirement = await this.query.requirementByIdAs(
      row.requirement_id,
      actor,
    );
    if (requirement.type !== '工单')
      throw new ConflictException('关联需求已更改类型，请先在需求平台核对');
    return {
      conversationId: row.conversation_id,
      requirement,
      context: includeContext ? JSON.parse(row.payload_json) : undefined,
      state: 'linked' as const,
    };
  }
  private async reconcile(
    row: IntakeRow,
    actor: CurrentUserSummary,
    includeContext = true,
  ) {
    const records = await this.feishu.searchRecords(
      this.query.table('FEISHU_REQUIREMENTS_TABLE'),
      {
        conjunction: 'and',
        conditions: [
          { fieldName: 'Relay 会话标识', operator: 'is', value: [row.marker] },
        ],
      },
      'user_id',
    );
    if (
      records.length !== 1 ||
      textValue(records[0].fields['Relay 会话标识']) !== row.marker
    ) {
      throw new ConflictException(
        records.length > 1
          ? '发现重复关联，需人工核对'
          : '建单结果尚未确认，不会重复创建',
      );
    }
    await this.store.finish(row, records[0].record_id);
    this.query.invalidate();
    return this.result(
      { ...row, requirement_id: records[0].record_id, state: 'linked' },
      actor,
      includeContext,
    );
  }
  async get(conversationId: string, actor: CurrentUserSummary) {
    const { source } = this.settings();
    const row = await this.store.read(source, conversationId);
    if (!row) throw new NotFoundException('咨询尚未关联工单');
    if (row.state !== 'linked') {
      if (['writing', 'unknown'].includes(row.state))
        return this.reconcile(row, actor, false);
      throw new ConflictException('建单尚未完成，可使用原请求重试');
    }
    return this.result(row, actor, false);
  }
  async context(marker: string, actor: CurrentUserSummary) {
    if (!/^relay_v1:[a-f0-9]{64}$/.test(marker))
      throw new NotFoundException('对话快照不存在');
    const row = await this.store.byMarker(marker);
    if (!row?.requirement_id)
      throw new NotFoundException('对话快照尚未关联需求');
    await this.query.requirementByIdAs(row.requirement_id, actor);
    return JSON.parse(row.payload_json);
  }
  async group(conversationId: string, actor: CurrentUserSummary) {
    const result = await this.get(conversationId, actor);
    if (result.requirement.type !== '工单')
      throw new ConflictException('关联记录已更改类型，请先核对');
    await this.command.runGroupActionAs(
      result.requirement.id,
      result.requirement.groupChatId ? 'sync' : 'create',
      actor,
    );
    return this.get(conversationId, actor);
  }
}
