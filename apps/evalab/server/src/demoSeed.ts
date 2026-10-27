import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppContext } from './context.js';
import { withTx } from './db.js';
import { sha256Hex } from './security.js';

export async function seedDemo(ctx: AppContext): Promise<void> {
  if (ctx.config.nodeEnv === 'production') throw new Error('SEED_DEMO refused in production');
  await mkdir(path.resolve(ctx.config.storageDir), { recursive: true });
  await withTx(ctx.pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('110lab-demo-seed'))`);
    const round = await ensureRound(client, '2026秋季招新');
    const batch = await ensureBatch(client, round, {
      name: '第一批',
      description: '招新考核演示批次。开始后按本批次时长完成仓库与 MCP 材料提交，并在网站确认交卷。',
      status: 'OPEN',
    });
    const note = await ensureTextAttachment(ctx, client, '考核说明.txt', '请在截止前确认仓库 SHA 与 MCP 材料一致。不要提交密钥或其他项目的聊天记录。');
    await ensureQuestion(client, batch, 'PRODUCT', '候选人旅程与信息边界', '设计本次招新考核的候选人旅程，说明同意、MCP 预检、题目锁定、仓库 SHA 与材料确认如何避免误传其他项目数据。', note);
    await ensureQuestion(client, batch, 'DEVELOPMENT_TEST', '持久化考核状态', '实现一个带数据库事务的开始考核接口：并发点击只能抽到同一题、同一截止时间，题库为空时不得写入开始时间。', note);
  });
}

async function ensureRound(client: import('pg').PoolClient, name: string): Promise<string> {
  const found = await client.query<{ id: string }>('SELECT id FROM rounds WHERE name = $1', [name]);
  if (found.rows[0]) return found.rows[0].id;
  const inserted = await client.query<{ id: string }>('INSERT INTO rounds (name) VALUES ($1) RETURNING id', [name]);
  return inserted.rows[0]?.id ?? '';
}

async function ensureBatch(client: import('pg').PoolClient, roundId: string, input: { name: string; description: string; status: string }): Promise<string> {
  const found = await client.query<{ id: string }>('SELECT id FROM batches WHERE round_id = $1 AND name = $2', [roundId, input.name]);
  if (found.rows[0]) return found.rows[0].id;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO batches (round_id, name, description, opens_at, start_closes_at, duration_hours, status)
     VALUES ($1, $2, $3, now() - interval '1 day', now() + interval '14 days', 24, $4) RETURNING id`,
    [roundId, input.name, input.description, input.status],
  );
  return inserted.rows[0]?.id ?? '';
}

async function ensureTextAttachment(ctx: AppContext, client: import('pg').PoolClient, name: string, content: string): Promise<string> {
  const found = await client.query<{ id: string }>('SELECT id FROM attachments WHERE original_name = $1 LIMIT 1', [name]);
  if (found.rows[0]) return found.rows[0].id;
  const id = randomUUID();
  const data = Buffer.from(content, 'utf8');
  await writeFile(path.join(path.resolve(ctx.config.storageDir), id), data, { flag: 'wx' });
  await client.query(
    `INSERT INTO attachments (id, stored_name, original_name, content_type, size_bytes, sha256)
     VALUES ($1::uuid, $1::text, $2, 'text/plain', $3, $4)`,
    [id, name, data.length, sha256Hex(data)],
  );
  return id;
}

async function ensureQuestion(client: import('pg').PoolClient, batchId: string, direction: string, title: string, content: string, attachmentId: string): Promise<void> {
  const found = await client.query<{ id: string }>('SELECT id FROM questions WHERE batch_id = $1 AND title = $2', [batchId, title]);
  if (found.rows[0]) return;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO questions (batch_id, direction, title, content, published) VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [batchId, direction, title, content],
  );
  const id = inserted.rows[0]?.id;
  if (!id) return;
  await client.query('INSERT INTO question_attachments (question_id, attachment_id, position) VALUES ($1, $2, 0)', [id, attachmentId]);
  await client.query(
    `INSERT INTO question_versions (question_id, version_no, title, content, attachment_ids) VALUES ($1, 1, $2, $3, $4::uuid[])`,
    [id, title, content, [attachmentId]],
  );
}
