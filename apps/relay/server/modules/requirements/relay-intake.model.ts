import { createHash } from 'node:crypto';
import { z } from 'zod';
const id = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[\w.:/-]+$/);
const label = (max: number) => z.string().trim().min(1).max(max);
export const safeLink = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
      );
    } catch {
      return false;
    }
  }, '链接必须是 HTTP(S) 地址');
const message = z
  .object({
    id,
    side: label(40),
    content: z.string().max(20000),
    time: label(80),
    private: z.boolean().optional(),
    attachments: z
      .array(z.object({ id, name: label(200), url: safeLink }).strict())
      .max(20)
      .optional(),
  })
  .strict();
export const relayTicketInput = z
  .object({
    conversationId: id,
    title: label(200),
    description: z.string().trim().max(20000),
    sourceApp: label(80),
    sourceUrl: safeLink,
    customerName: label(120),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
    handlerLarkUserIds: z
      .array(z.string().regex(/^[\w-]{1,128}$/))
      .max(50)
      .default([])
      .transform((v) => [...new Set(v)]),
    messages: z.array(message).max(500),
  })
  .strict()
  .refine(
    (v) => Buffer.byteLength(JSON.stringify(v)) <= 500000,
    '对话上下文过大',
  );
export type RelayTicketInput = z.infer<typeof relayTicketInput>;
export function relayMarker(source: string, conversation: string): string {
  return (
    'relay_v1:' +
    createHash('sha256')
      .update(JSON.stringify([source, conversation]))
      .digest('hex')
  );
}
export function intakeDigest(input: RelayTicketInput): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(input)))
    .digest('hex');
}
const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Plain Markdown, with HTML and link delimiters escaped. Never fetches source URLs. */
export function relayIntroduction(
  input: RelayTicketInput,
  fullContextUrl?: string,
): string {
  const lines = [
    escape(input.description),
    '',
    '## 咨询信息',
    `来源应用：${escape(input.sourceApp)}`,
    `咨询用户：${escape(input.customerName)}`,
    `[打开原咨询](${new URL(input.sourceUrl).href.replace(/[()]/g, (c) => encodeURIComponent(c))})`,
    '',
    '## 对话上下文',
  ];
  if (fullContextUrl) lines.push(`[下载完整对话快照](${fullContextUrl})`);
  let included = 0;
  for (const m of input.messages) {
    const block = [
      '',
      `### ${escape(m.side)} · ${escape(m.time)}${m.private ? ' · 内部备注' : ''}`,
      escape(m.content),
    ];
    for (const f of m.attachments || [])
      block.push(
        `- [${escape(f.name).replace(/[\[\]]/g, '')}](${new URL(f.url).href.replace(/[()]/g, (c) => encodeURIComponent(c))})`,
      );
    if (lines.join('\n').length + block.join('\n').length > 49000) break;
    lines.push(...block);
    included++;
  }
  if (included < input.messages.length)
    lines.push(
      '',
      `其余 ${input.messages.length - included} 条消息见完整对话快照或原咨询。`,
    );
  return lines.join('\n');
}
