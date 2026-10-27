import { createHmac } from 'node:crypto';
import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
} from 'node:fs';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
const safeOrigin = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === '/' &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(u.hostname)))
    );
  });
export const chatwootConfig = z
  .object({
    origin: safeOrigin,
    pathPrefix: z
      .string()
      .regex(/^\/[a-zA-Z0-9_-]+$/)
      .optional(),
    gatewayToken: z.string().min(32).max(200).optional(),
    accountId: z.number().int().positive().safe(),
    token: z.string().min(10).max(4096),
    apps: z.record(
      z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      z
        .object({
          inboxId: z.number().int().positive().safe(),
          identifier: z.string().regex(/^[\w-]{1,200}$/),
          hmacToken: z.string().min(16),
          name: z.string().min(1).max(80),
        })
        .strict(),
    ),
    operators: z.record(
      z.string().min(1).max(128),
      z.number().int().positive().safe(),
    ),
  })
  .strict();
export type ChatwootConfig = z.infer<typeof chatwootConfig>;
export class ChatwootError extends ServiceUnavailableException {
  constructor(
    readonly rejected: boolean,
    readonly remoteStatus: number = 0,
  ) {
    super(
      rejected
        ? 'Chatwoot 拒绝了操作，请核对权限或内容'
        : 'Chatwoot 操作结果待确认，请使用原请求重试查询',
    );
  }
}
export function readChatwootConfig(): ChatwootConfig {
  let fd: number | undefined;
  try {
    const value = process.env.RELAY_CHATWOOT_CONFIG_JSON;
    if (value) {
      if (Buffer.byteLength(value) > 65536) throw Error();
      return chatwootConfig.parse(JSON.parse(value));
    }
    if (!process.env.RELAY_CHATWOOT_CONFIG) throw Error();
    fd = openSync(
      process.env.RELAY_CHATWOOT_CONFIG,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.size > 65536 ||
      st.mode & 0o077 ||
      (process.getuid && st.uid !== process.getuid())
    )
      throw Error();
    return chatwootConfig.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } catch {
    throw new ServiceUnavailableException('Relay 尚未配置 Chatwoot 连接');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
@Injectable()
export class ChatwootClient {
  config() {
    return readChatwootConfig();
  }
  gatewayHeaders(): Record<string, string> {
    const token = this.config().gatewayToken;
    return token ? { 'X-Relay-Gateway-Key': token } : {};
  }
  async request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      public?: boolean;
      form?: FormData;
    } = {},
  ): Promise<any> {
    const c = this.config();
    let r: Response;
    try {
      r = await fetch(new URL((c.pathPrefix || '') + path, c.origin), {
        method: options.method || 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: {
          ...this.gatewayHeaders(),
          ...(options.public
            ? {}
            : c.gatewayToken
              ? { 'X-Relay-Chatwoot-Token': c.token }
              : { api_access_token: c.token }),
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        body:
          options.form ??
          (options.body ? JSON.stringify(options.body) : undefined),
      });
    } catch {
      throw new ChatwootError(false);
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (!r.body) throw Error();
      for await (const chunk of r.body) {
        if ((size += chunk.length) > 4000000) {
          await r.body.cancel().catch(() => {});
          throw Error();
        }
        chunks.push(chunk);
      }
      if (!r.ok)
        throw new ChatwootError(r.status >= 400 && r.status < 500, r.status);
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch (e) {
      if (e instanceof ChatwootError) throw e;
      throw new ChatwootError(false, r.status);
    }
  }
  account(suffix: string) {
    return `/api/v1/accounts/${this.config().accountId}${suffix}`;
  }
  contact(app: string, source = '') {
    const v = this.config().apps[app];
    if (!v) throw new ServiceUnavailableException('应用咨询入口尚未配置');
    return `/public/api/v1/inboxes/${v.identifier}/contacts${source ? '/' + encodeURIComponent(source) : ''}`;
  }
  contactInput(app: string, principal: string, name: string) {
    return {
      identifier: principal,
      identifier_hash: createHmac('sha256', this.config().apps[app].hmacToken)
        .update(principal)
        .digest('hex'),
      name,
    };
  }
  async messages(id: number) {
    let all: any[] = [],
      before = '';
    for (let page = 0; page < 26; page++) {
      const v = await this.request(
        this.account(`/conversations/${id}/messages`) +
          (before ? '?before=' + before : ''),
      );
      if (!Array.isArray(v.payload)) throw new ChatwootError(false);
      all = [...v.payload, ...all];
      if (all.length > 500)
        throw new ServiceUnavailableException(
          '对话超过 500 条，请分段处理；未截断上下文建单',
        );
      if (v.payload.length < 20) return all;
      const next = String(Math.min(...v.payload.map((m: any) => m.id)));
      if (next === before) throw new ChatwootError(false);
      before = next;
    }
    throw new ChatwootError(false);
  }
  async operator(employeeId: string, app?: string) {
    const id = this.config().operators[employeeId];
    if (!id) return false;
    const agents = await this.request(this.account('/agents'));
    if (
      !Array.isArray(agents) ||
      !agents.some(
        (a: any) => a.id === id && ['administrator', 'agent'].includes(a.role),
      )
    )
      return false;
    if (app) {
      const members = await this.request(
        this.account(`/inbox_members/${this.config().apps[app].inboxId}`),
      );
      if (
        !Array.isArray(members.payload) ||
        !members.payload.some((m: any) => m.id === id)
      )
        return false;
    }
    return true;
  }
}
