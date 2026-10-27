import { BadRequestException, Body, ConflictException, Controller, Header, HttpCode, Post, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DrizzleDatabaseManager } from './database';
import { RequestContextService } from './context';
import { WorkspaceRecordStore } from '../../database/workspace-record.store';

const inputSchema = z.object({
  operation: z.enum(['list', 'upsert', 'delete']),
  collection: z.enum(['requirements', 'iterations', 'bindings', 'operations', 'collaboration']),
  recordId: z.string().regex(/^rec[\w-]{1,100}$/).optional(),
  fields: z.record(z.string().min(1).max(120), z.unknown()).optional(),
  fieldNames: z.array(z.string().min(1).max(120)).max(200).optional(),
  offset: z.number().int().min(0).max(1000000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  requestId: z.string().uuid().optional(),
}).strict();
const tableVariables = {
  requirements: 'FEISHU_REQUIREMENTS_TABLE', iterations: 'FEISHU_ITERATIONS_TABLE',
  bindings: 'FEISHU_BINDINGS_TABLE', operations: 'FEISHU_OPERATIONS_TABLE',
  collaboration: 'FEISHU_COLLABORATION_TABLE',
};
const requirementMetadata = new Set(['需求群ID', '需求群链接', '需求群聊', '拉群状态', '拉群时间',
  '群成员同步时间', '最近通知版本', '最近通知时间', '最近通知摘要']);

/** Dedicated legacy-bot transport. Browser and human MCP credentials cannot use it. */
@Controller('openapi/iteration-bot')
export class MakitIterationBotController {
  constructor(private readonly records: WorkspaceRecordStore, private readonly database: DrizzleDatabaseManager,
    private readonly context: RequestContextService) {}

  @Post('records')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  async request(@Body() body: unknown) {
    if (process.env.MAKIT_ITERATION_BOT_ENABLED !== 'true') throw new ServiceUnavailableException('机器人数据入口尚未启用');
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('机器人请求格式无效');
    const input = parsed.data, table = process.env[tableVariables[input.collection]];
    if (!table) throw new ServiceUnavailableException('机器人数据集尚未配置');
    if (input.operation === 'list') {
      const rows = await this.records.listRecords(table, input.fieldNames, 'open_id');
      const offset = input.offset || 0, limit = input.limit || 200;
      return { source: 'makit-postgres-v1', items: rows.slice(offset, offset + limit), hasMore: offset + limit < rows.length };
    }
    if (process.env.MAKIT_WORKERS_ENABLED !== 'true' || process.env.MAKIT_EXTERNAL_WRITES_ENABLED !== 'true')
      throw new ServiceUnavailableException('机器人写入已暂停');
    if (!input.requestId || (input.operation === 'delete' && (!input.recordId || input.collection !== 'iterations')) ||
      (input.operation === 'upsert' && (!input.fields || !Object.keys(input.fields).length)))
      throw new BadRequestException('机器人变更参数无效');
    // The bot may maintain delivery/group metadata, never bypass the normal
    // requirement workflow to edit status, assignees or project content.
    if (input.collection === 'requirements' && (!input.recordId || input.operation !== 'upsert' ||
      Object.keys(input.fields || {}).some((name) => !requirementMetadata.has(name))))
      throw new BadRequestException('机器人只能维护需求通知和群聊信息');
    if (input.fields) {
      const writable = new Set((await this.records.listFields(table)).filter((field) => !/^100[1-5]$/.test(field.type)).map((field) => field.name));
      if (Object.keys(input.fields).some((name) => !writable.has(name))) throw new BadRequestException('机器人变更含有不可写字段');
    }
    const sql = this.database.client, hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const reserved = await sql`INSERT INTO makit_bot_request (id, payload_hash, collection, record_id, operation)
      VALUES (${input.requestId}, ${hash}, ${input.collection}, ${input.recordId || ''}, ${input.operation}) ON CONFLICT DO NOTHING RETURNING id`;
    if (!reserved.length) {
      const [previous] = await sql`SELECT payload_hash,state,result FROM makit_bot_request WHERE id=${input.requestId}`;
      if (previous?.payload_hash !== hash || previous.state !== 'completed')
        throw new ConflictException('机器人操作结果需核对，禁止重复提交');
      return previous.result;
    }
    try {
      const item = await this.context.run({ auditPrincipal: 'app_makit_iteration_bot' }, async () => {
        if (input.operation === 'delete') { await this.records.deleteRecord(table, input.recordId!); return null; }
        return input.recordId ? this.records.updateRecord(table, input.recordId, input.fields!, 'open_id')
          : this.records.createRecord(table, input.fields!, 'open_id');
      });
      const result = { source: 'makit-postgres-v1', item };
      await sql`UPDATE makit_bot_request SET state='completed',result=${sql.json(result as never)},updated_at=now() WHERE id=${input.requestId}`;
      return result;
    } catch (error) {
      // A crash between the business commit and receipt update stays unknown.
      // Retrying the same request must never repeat an uncertain creation.
      await sql`UPDATE makit_bot_request SET state='unknown',updated_at=now() WHERE id=${input.requestId}`;
      throw error;
    }
  }
}
