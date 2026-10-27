import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { StorageService } from '../../integrations/storage/storage.service';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { join, extname } from 'node:path';
import { excerpt, searchTerms, likeLiteral } from './search-text';

const SOURCES = sql<any>`(
 select 'office:'||v.id::text as id, v.page_id, v.id::text as source_version, v.file_name, v.storage_path, v.size::bigint as size
 from office_file_versions v join pages p on p.id=v.page_id and p.deleted_at is null
 where v.version=(select max(v2.version) from office_file_versions v2 where v2.page_id=v.page_id)
 union all
 select 'attachment:'||a.id::text, a.page_id, a.updated_at::text, a.file_name, a.file_path, a.file_size
 from attachments a join pages p on p.id=a.page_id and p.deleted_at is null where a.deleted_at is null
)`;

export async function readIndexBytes(
  storage: StorageService,
  path: string,
): Promise<Buffer> {
  let stream: Readable | undefined,
    expired = false,
    timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      stream?.destroy();
      reject(new Error('读取文件超时'));
    }, 10000);
  });
  const work = (async () => {
    stream = await storage.readStream(path);
    if (expired) {
      stream.destroy();
      throw new Error('读取文件超时');
    }
    const parts: Buffer[] = [];
    let length = 0;
    for await (const b of stream) {
      length += b.length;
      if (length > 20 * 1024 * 1024) {
        stream.destroy();
        throw new Error('文件超过全文索引的 20 MB 限制');
      }
      parts.push(Buffer.from(b));
    }
    return Buffer.concat(parts);
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function parseInChild(bytes: Buffer, ext: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=192', join(__dirname, 'file-text.worker.js'), ext],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('提取超时'));
    }, 15000);
    let output = '',
      finished = false;
    child.stdout.on('data', (b) => {
      output += b;
      if (output.length > 8_000_000) {
        child.kill('SIGKILL');
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      try {
        const v = JSON.parse(output);
        if (code || v.error) throw new Error(v.error || '文件解析失败');
        resolve(v.text);
      } catch {
        reject(new Error('无法提取文本，文件可能损坏或超过索引限制'));
      }
    });
    child.stdin.end(bytes);
  });
}

@Injectable()
export class FileIndexService {
  private busy = false;
  private logger = new Logger(FileIndexService.name);
  constructor(
    @InjectKysely() private db: Kysely<any>,
    private storage: StorageService,
    private spaces: SpaceMemberRepo,
    private permissions: PagePermissionRepo,
  ) {}

  @Interval(20000)
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // A database lock prevents duplicate parser work across application replicas.
      await this.db.transaction().execute(async (trx) => {
        const lock = await sql<{
          locked: boolean;
        }>`select pg_try_advisory_xact_lock(110,251025) as locked`.execute(trx);
        if (!lock.rows[0]?.locked) return;
        await trx
          .deleteFrom('documentFileIndex')
          .where(
            'id',
            'not in',
            trx.selectFrom(SOURCES.as('source')).select('source.id'),
          )
          .execute();
        const rows = await trx
          .selectFrom(SOURCES.as('source'))
          .selectAll('source')
          .leftJoin('documentFileIndex as idx', 'idx.id', 'source.id')
          .where((eb) =>
            eb.or([
              eb('idx.id', 'is', null),
              eb('idx.sourceVersion', '!=', eb.ref('source.sourceVersion')),
            ]),
          )
          .limit(3)
          .execute();
        for (const row of rows) {
          let text = '',
            status = 'ready',
            error: string | null = null;
          try {
            if (row.size === null || Number(row.size) > 20 * 1024 * 1024)
              throw new Error('文件超过全文索引的 20 MB 限制');
            text = await parseInChild(
              await readIndexBytes(this.storage, row.storagePath),
              extname(row.fileName).slice(1).toLowerCase(),
            );
            if (!text) {
              status = 'empty';
              error = '未提取到文字；扫描件暂不支持 OCR';
            }
          } catch (e: any) {
            status = 'failed';
            error = /^(文件超过|读取文件超时|提取超时|无法提取|此格式)/.test(
              e.message,
            )
              ? e.message
              : '无法读取文件，请稍后重新上传或联系管理员';
          }
          await trx
            .insertInto('documentFileIndex')
            .values({
              id: row.id,
              pageId: row.pageId,
              sourceVersion: row.sourceVersion,
              fileName: row.fileName,
              text,
              status,
              error,
              indexedAt: new Date(),
            })
            .onConflict((oc) =>
              oc
                .column('id')
                .doUpdateSet({
                  sourceVersion: row.sourceVersion,
                  text,
                  status,
                  error,
                  indexedAt: new Date(),
                }),
            )
            .execute();
        }
      });
    } catch {
      this.logger.warn('File indexing deferred; next scheduled run will retry');
    } finally {
      this.busy = false;
    }
  }

  async search(dto: any, userId: string, workspaceId: string) {
    const terms = searchTerms(dto.query || '');
    if (!terms.length) return { items: [] };
    let query = this.db
      .selectFrom(SOURCES.as('source'))
      .innerJoin('pages as p', 'p.id', 'source.pageId')
      .innerJoin('spaces as s', 's.id', 'p.spaceId')
      .leftJoin('documentFileIndex as idx', (join) =>
        join
          .onRef('idx.id', '=', 'source.id')
          .onRef('idx.sourceVersion', '=', 'source.sourceVersion'),
      )
      .select([
        'source.id',
        'source.fileName',
        'p.id as pageId',
        'p.title',
        'p.slugId',
        'p.creatorId',
        'p.createdAt',
        'p.updatedAt',
        's.id as spaceId',
        's.name as spaceName',
        's.slug as spaceSlug',
        's.logo as spaceIcon',
        'idx.text',
        'idx.status',
        'idx.error',
      ])
      .where('p.workspaceId', '=', workspaceId)
      .where('p.spaceId', 'in', this.spaces.getUserSpaceIdsQuery(userId));
    if (dto.spaceId) query = query.where('p.spaceId', '=', dto.spaceId);
    if (dto.creatorId) query = query.where('p.creatorId', '=', dto.creatorId);
    if (dto.labelIds?.length)
      query = query.where(
        'p.id',
        'in',
        this.db
          .selectFrom('pageLabels')
          .select('pageId')
          .where('labelId', 'in', dto.labelIds),
      );
    for (const term of terms)
      query = query.where(
        sql<boolean>`(source.file_name ilike ${likeLiteral(term)} or ${!dto.titleOnly} and idx.status='ready' and idx.text ilike ${likeLiteral(term)})`,
      );
    const visible: any[] = [];
    let offset = 0;
    while (visible.length < 25) {
      const batch = await query
        .orderBy('p.updatedAt', 'desc')
        .orderBy('source.id', 'asc')
        .limit(100)
        .offset(offset)
        .execute();
      if (!batch.length) break;
      const allowed = new Set(
        await this.permissions.filterAccessiblePageIds({
          pageIds: batch.map((r) => r.pageId),
          userId,
        }),
      );
      visible.push(...batch.filter((r) => allowed.has(r.pageId)));
      offset += batch.length;
      if (batch.length < 100) break;
    }
    return {
      items: visible
        .slice(0, 25)
        .map((r) => ({
          id: r.id,
          fileName: r.fileName,
          pageId: r.pageId,
          creatorId: r.creatorId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          indexStatus: r.status || 'pending',
          indexMessage: r.error,
          highlight: excerpt(r.status === 'ready' ? r.text : '', terms),
          space: {
            id: r.spaceId,
            name: r.spaceName,
            slug: r.spaceSlug,
            icon: r.spaceIcon,
          },
          page: { id: r.pageId, title: r.title, slugId: r.slugId },
        })),
    };
  }
}
