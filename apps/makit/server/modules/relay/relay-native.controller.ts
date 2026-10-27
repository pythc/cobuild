import {
  Controller,
  Post,
  Body,
  Req,
  Header,
  HttpCode,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { LabIdentityService } from '../requirements/lab-identity.service';
import { RelayIntakeService } from '../requirements/relay-intake.service';
import { RequirementsCommandService } from '../requirements/requirements-command.service';
import { updateInput } from './relay-chatwoot.input';
import { withSelfhostActor } from '../../common/selfhost/context';
const inputSchema = z
  .object({
    action: z.enum(['members', 'create', 'lookup', 'group', 'update']),
    token: z.string().regex(/^[\w-]{43}$/),
    input: z.unknown(),
  })
  .strict();
const conversationSchema = z
  .object({ conversationId: z.string().regex(/^[\w-]{1,128}$/) })
  .strict();
@Controller('openapi/relay-native')
export class RelayNativeController {
  constructor(
    private readonly identity: LabIdentityService,
    private readonly intake: RelayIntakeService,
    private readonly command: RequirementsCommandService,
  ) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  async dispatch(@Req() req: Request, @Body() body: unknown) {
    const key = process.env.RELAY_NATIVE_SERVICE_KEY || '',
      given = req.headers['x-relay-native-key'];
    if (
      key.length < 32 ||
      typeof given !== 'string' ||
      Buffer.byteLength(given) !== Buffer.byteLength(key) ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(key))
    )
      throw new UnauthorizedException();
    const v = inputSchema.parse(body),
      actor = await this.identity.actor(v.token, 'relay');
    if (['create', 'group', 'update'].includes(v.action)) {
      let response: Response;
      try {
        response = await fetch(
          'https://internal.110-lab.cn/api/application-access/service/relay',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Relay-Access-Key': process.env.RELAY_ACCESS_SERVICE_KEY || '',
            },
            body: JSON.stringify({ employeeId: actor.employeeId }),
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
          },
        );
      } catch {
        throw new ServiceUnavailableException('客服权限暂时无法核对');
      }
      if (!response.ok)
        throw new ServiceUnavailableException('客服权限暂时无法核对');
      const decision: unknown = await response.json();
      if (
        !decision ||
        typeof decision !== 'object' ||
        !('allowed' in decision) ||
        decision.allowed !== true
      )
        throw new ForbiddenException('需要客服权限');
    }
    return withSelfhostActor(actor, async () => {
    if (v.action === 'members') return this.intake.members(actor);
    if (v.action === 'create') return this.intake.create(v.input, actor);
    if (v.action === 'update') {
      const input = z
        .object({
          conversationId: z.string().regex(/^[\w-]{1,128}$/),
          revision: z.union([z.number(), z.string(), z.null()]),
          status: z.string(),
          handlerIds: z.array(z.string()),
          note: z.string(),
        })
        .strict()
        .parse(v.input);
      const patch = updateInput.parse({
        revision: input.revision,
        status: input.status,
        handlerIds: input.handlerIds,
        note: input.note,
      });
      const current = await this.intake.get(input.conversationId, actor);
      await this.command.updateRequirementAs(
        current.requirement.id,
        {
          expectedUpdatedAt: patch.revision,
          patch: {
            status: patch.status,
            handlerLarkUserIds: patch.handlerIds,
            latestProgress: patch.note,
          },
        },
        actor,
      );
      return this.intake.get(input.conversationId, actor);
    }
    const { conversationId } = conversationSchema.parse(v.input);
    return v.action === 'group'
      ? this.intake.group(conversationId, actor)
      : this.intake.get(conversationId, actor);
    });
  }
}
