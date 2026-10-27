import { createHash } from 'node:crypto';
import { z } from 'zod';
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v: string) => !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(v));
export const projectName = text(80)
  .trim()
  .min(1)
  .refine((v: string) => !/[\r\n\t]/u.test(v));
const link = z
  .string()
  .max(2000)
  .refine((v: string) => {
    if (!v) return true;
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password;
    } catch {
      return false;
    }
  });
export const projectSnapshot = z
  .object({
    phase: z.enum([
      'exploring',
      'pending',
      'active',
      'needs_changes',
      'unconfigured',
    ]),
    archived: z.boolean(),
    ownerName: text(120),
    memberNames: z.array(text(120)).max(100),
    application: text(2000),
    reviewNote: text(1000),
    aliases: z.array(projectName).max(200),
    links: z
      .object({ repository: link, requirements: link, docs: link, demo: link, knowledgeSpace: link.optional() })
      .strict(),
    milestones: z
      .array(
        z
          .object({
            id: z.uuid(),
            title: text(160),
            assigneeName: text(120),
            dueAt: z.iso.datetime().nullable(),
            status: z.enum(['open', 'done']),
          })
          .strict(),
      )
      .max(100),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const projectSyncInput = z
  .object({
    sourceProjectId: z.uuid(),
    name: projectName,
    summary: text(800).trim(),
    revision: z.number().int().positive().max(2147483647).optional(),
    snapshot: projectSnapshot.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.snapshot) === Boolean(v.revision))
  .refine((v) => !!v.summary || v.snapshot?.phase === 'unconfigured');
export function classificationId(key: string): string {
  const h: string = createHash('sha256')
    .update('110lab-requirement-classification:' + key)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function projectDigest(input: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, value]) => [k, stable(value)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(input)))
    .digest('hex');
}
