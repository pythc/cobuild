import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { CurrentUserSummary } from '@shared/api.interface';
import { FeishuService } from './feishu.service';
const actionInput = z
  .object({
    projectId: z.uuid(),
    requestId: z.uuid(),
    action: z.enum([
      'read',
      'knowledge_link',
      'milestone_add',
      'milestone_set',
    ]),
    input: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();
@Injectable()
export class ProjectActionService {
  constructor(private readonly feishu: FeishuService) {}
  async execute(actor: CurrentUserSummary, body: unknown): Promise<unknown> {
    if(process.env.COBUILD_IDENTITY_MODE==='local')throw new ServiceUnavailableException('套件项目连接尚未接入');
    const parsed = actionInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('项目操作参数无效');
    const secret = process.env.PORTAL_PROJECT_BRIDGE_SECRET || '';
    if (secret.length < 32)
      throw new ServiceUnavailableException('项目管理连接尚未配置');
    const subject = await this.feishu.projectSubject(actor.employeeId);
    const envelope = { ...parsed.data, subject, at: Date.now() };
    const signature = createHmac('sha256', secret)
      .update(JSON.stringify(envelope))
      .digest('hex');
    let response: Response;
    try {
      response = await fetch(
        'https://internal.110-lab.cn/api/workspace/project-actions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-project-signature': signature,
          },
          body: JSON.stringify(envelope),
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        '项目操作结果待确认，重试将复用同一请求',
      );
    }
    let bytes = 0;
    const parts: Uint8Array[] = [];
    for await (const part of response.body!) {
      if ((bytes += part.length) > 262144)
        throw new ServiceUnavailableException('项目响应过大');
      parts.push(part);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      throw new ServiceUnavailableException('项目响应无效');
    }
    if (!response.ok) {
      const error = value as { error?: string };
      throw new HttpException(
        error.error || '项目操作失败',
        [400, 401, 403, 404, 409, 429].includes(response.status)
          ? response.status
          : 503,
      );
    }
    return value;
  }
}
