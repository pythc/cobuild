import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Busboy from 'busboy';
import type { Pool } from 'pg';
import type { AppContext } from './context.js';
import { HttpError } from './errors.js';
import { sha256Hex } from './security.js';
import type { PublicUser } from './auth.js';

const MAX_BYTES = 20 * 1024 * 1024;

const TYPES: Record<string, { ext: string; sniff: (buf: Buffer) => boolean }> = {
  'application/pdf': { ext: 'pdf', sniff: (buf) => buf.subarray(0, 4).toString('ascii') === '%PDF' },
  'image/png': { ext: 'png', sniff: (buf) => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', sniff: (buf) => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff },
  'image/gif': { ext: 'gif', sniff: (buf) => buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a' },
  'image/webp': {
    ext: 'webp',
    sniff: (buf) => buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  'text/plain': { ext: 'txt', sniff: (buf) => !buf.subarray(0, 512).includes(0) },
  'text/markdown': { ext: 'md', sniff: (buf) => !buf.subarray(0, 512).includes(0) },
  'application/zip': { ext: 'zip', sniff: (buf) => buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) },
};

export type StoredAttachment = { id: string; name: string; size: number; url: string };

export async function saveAttachment(
  ctx: AppContext,
  userId: string,
  file: { filename: string; contentType: string; data: Buffer },
): Promise<StoredAttachment> {
  if (file.data.length <= 0 || file.data.length > MAX_BYTES) {
    throw new HttpError(413, '附件超过 20MB 限制', 'FILE_TOO_LARGE');
  }
  const rule = TYPES[file.contentType];
  if (!rule || !rule.sniff(file.data)) {
    throw new HttpError(400, '附件类型不受支持', 'VALIDATION');
  }
  const name = sanitizeName(file.filename, rule.ext);
  const id = randomUUID();
  const root = path.resolve(ctx.config.storageDir);
  await mkdir(root, { recursive: true });
  const target = path.join(root, id);
  await writeFile(target, file.data, { flag: 'wx' });
  try {
    await ctx.pool.query(
      `INSERT INTO attachments (id, stored_name, original_name, content_type, size_bytes, sha256, uploaded_by)
       VALUES ($1::uuid, $1::text, $2, $3, $4, $5, $6)`,
      [id, name, file.contentType, file.data.length, sha256Hex(file.data), userId],
    );
  } catch (error) {
    await unlink(target).catch(() => undefined);
    throw error;
  }
  return { id, name, size: file.data.length, url: `/api/attachments/${id}` };
}

export async function openAttachment(ctx: AppContext, user: PublicUser, attachmentId: string): Promise<{
  stream: ReturnType<typeof createReadStream>;
  name: string;
  contentType: string;
  size: number;
}> {
  const found = await ctx.pool.query<{ stored_name: string; original_name: string; content_type: string; size_bytes: number }>(
    'SELECT stored_name, original_name, content_type, size_bytes FROM attachments WHERE id = $1',
    [attachmentId],
  );
  const row = found.rows[0];
  if (!row || !/^[0-9a-f-]{36}$/i.test(row.stored_name)) {
    throw new HttpError(404, '未找到', 'NOT_FOUND');
  }
  if (user.role !== 'ADMIN') {
    const allowed = await ctx.pool.query(
      `SELECT 1 FROM enrollments e
       JOIN question_versions v ON v.id = e.question_version_id
       WHERE e.user_id = $1 AND e.started_at IS NOT NULL AND $2::uuid = ANY (v.attachment_ids)
       LIMIT 1`,
      [user.id, attachmentId],
    );
    if ((allowed.rowCount ?? 0) === 0) throw new HttpError(404, '未找到', 'NOT_FOUND');
  }
  const root = path.resolve(ctx.config.storageDir);
  const target = path.resolve(root, row.stored_name);
  if (target !== path.join(root, row.stored_name)) throw new HttpError(404, '未找到', 'NOT_FOUND');
  return {
    stream: createReadStream(target),
    name: row.original_name,
    contentType: TYPES[row.content_type] ? row.content_type : 'application/octet-stream',
    size: row.size_bytes,
  };
}

export function readMultipartFile(req: import('express').Request): Promise<{ filename: string; contentType: string; data: Buffer }> {
  const header = req.header('content-type') ?? '';
  if (!header.toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(400, '请使用 multipart 上传文件', 'VALIDATION');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof HttpError ? error : new HttpError(400, '无法解析上传', 'VALIDATION'));
    };
    const done = (value: { filename: string; contentType: string; data: Buffer }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: MAX_BYTES, fields: 20, fieldSize: 8 * 1024, parts: 24 },
      });
    } catch {
      fail(new HttpError(400, '无法解析上传', 'VALIDATION'));
      return;
    }
    let file: { filename: string; contentType: string; data: Buffer } | undefined;
    let tooBig = false;
    parser.on('file', (name, stream, info) => {
      if (name !== 'file') {
        stream.resume();
        fail(new HttpError(400, '请使用 file 字段上传', 'VALIDATION'));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('limit', () => {
        tooBig = true;
        stream.resume();
      });
      stream.on('data', (chunk: Buffer) => {
        if (!tooBig) chunks.push(chunk);
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (tooBig || settled) return;
        file = {
          filename: info.filename || 'attachment',
          contentType: info.mimeType || 'application/octet-stream',
          data: Buffer.concat(chunks),
        };
      });
    });
    parser.on('filesLimit', () => fail(new HttpError(400, '每次只允许上传一个附件', 'VALIDATION')));
    parser.on('fieldsLimit', () => fail(new HttpError(400, '上传字段过多', 'VALIDATION')));
    parser.on('partsLimit', () => fail(new HttpError(400, '上传字段过多', 'VALIDATION')));
    req.on('aborted', () => fail(new HttpError(400, '上传已中断，请重试', 'UPLOAD_ABORTED')));
    parser.on('error', fail);
    parser.on('close', () => {
      if (tooBig) {
        fail(new HttpError(413, '附件超过 20MB 限制', 'FILE_TOO_LARGE'));
        return;
      }
      if (!file) {
        fail(new HttpError(400, '请使用 file 字段上传', 'VALIDATION'));
        return;
      }
      done(file);
    });
    req.pipe(parser);
  });
}

function sanitizeName(filename: string, ext: string): string {
  const base = path.basename(filename).replace(/[^\w.\-\u4e00-\u9fff ()[\]]+/g, '_').slice(0, 80);
  const cleaned = base.replace(/^\.+/, '') || `attachment.${ext}`;
  return cleaned.slice(0, 120);
}

export async function attachmentMap(pool: Pool, ids: string[]): Promise<Map<string, { id: string; name: string; size: number; url: string }>> {
  const map = new Map<string, { id: string; name: string; size: number; url: string }>();
  if (ids.length === 0) return map;
  const rows = await pool.query<{ id: string; original_name: string; size_bytes: number }>(
    'SELECT id, original_name, size_bytes FROM attachments WHERE id = ANY($1::uuid[])',
    [ids],
  );
  for (const row of rows.rows) {
    map.set(row.id, { id: row.id, name: row.original_name, size: row.size_bytes, url: `/api/attachments/${row.id}` });
  }
  return map;
}
