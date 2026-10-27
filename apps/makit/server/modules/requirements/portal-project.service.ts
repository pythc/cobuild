import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ManagedProject,
  PortalProjectLookupResponse,
  PortalProjectSummary,
  ProjectCatalogResponse,
  ProjectManagementSnapshot,
} from '@shared/api.interface';
import { portalProject } from '../../database/schema';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import { FeishuService, type BaseField } from './feishu.service';
import {
  classificationId,
  projectDigest,
  projectName,
  projectSnapshot,
  projectSyncInput,
} from './project-management.model';
import { DEFAULT_REQUIREMENT_PLATFORM_URL } from './requirement-links';
const lookup = z.object({ sourceProjectId: z.uuid() }).strict();
type Row = Pick<
  typeof portalProject.$inferSelect,
  | 'id'
  | 'name'
  | 'summary'
  | 'sourceUrl'
  | 'snapshotJson'
  | 'sourceRevision'
  | 'sourceDigest'
  | 'updatedAt'
>;
// The service executor returns raw Postgres rows: aliases are required for
// snake_case columns; db.execute does not apply Drizzle's row mapper.
const projection = {
  id: portalProject.id,
  name: portalProject.name,
  summary: portalProject.summary,
  sourceUrl: sql<string>`${portalProject.sourceUrl}`.as('sourceUrl'),
  snapshotJson: sql<string>`${portalProject.snapshotJson}`.as('snapshotJson'),
  sourceRevision: sql<number>`${portalProject.sourceRevision}`.as(
    'sourceRevision',
  ),
  sourceDigest: sql<string>`${portalProject.sourceDigest}`.as('sourceDigest'),
  updatedAt: sql<Date>`${portalProject.updatedAt}`.as('updatedAt'),
};
@Injectable()
export class PortalProjectService {
  constructor(
    private readonly database: ServiceRoleDatabaseExecutor,
    @Optional() private readonly feishu?: FeishuService,
  ) {}
  private dto(row: Row): PortalProjectSummary {
    const url: URL = new URL((process.env.REQUIREMENT_PLATFORM_URL || DEFAULT_REQUIREMENT_PLATFORM_URL).replace(/\/+$/, '') + '/requirements');
    url.searchParams.set('project', row.name);
    return {
      sourceProjectId: row.id,
      projectId: row.id,
      projectName: row.name,
      projectSummary: row.summary,
      projectUrl: url.href,
      revision: row.sourceRevision || 0,
      digest: row.sourceDigest || null,
    };
  }
  private snapshot(row: Row): ProjectManagementSnapshot | null {
    if (!row.snapshotJson) return null;
    const parsed = projectSnapshot.safeParse(
      (() => {
        try {
          return JSON.parse(row.snapshotJson!);
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success)
      throw new ServiceUnavailableException('项目同步内容无效');
    return {
      ...parsed.data,
      milestones: parsed.data.milestones.map((m) => ({
        ...m,
        dueAt: m.dueAt ?? null,
      })),
    };
  }
  private rows(): Promise<Row[]> {
    return this.database.run((db) =>
      db.execute<Row>(
        db
          .select(projection)
          .from(portalProject)
          .orderBy(asc(portalProject.name)),
      ),
    );
  }
  async lookup(body: unknown): Promise<PortalProjectLookupResponse> {
    const parsed = lookup.safeParse(body);
    if (!parsed.success) throw new BadRequestException('项目 ID 无效');
    const rows: Row[] = await this.database.run((db) =>
      db.execute<Row>(
        db
          .select(projection)
          .from(portalProject)
          .where(eq(portalProject.id, parsed.data.sourceProjectId))
          .limit(1),
      ),
    );
    return { project: rows[0] ? this.dto(rows[0]) : null };
  }
  async register(body: unknown): Promise<PortalProjectSummary> {
    const parsed = projectSyncInput.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('项目名称、简介或版本无效');
    const input = parsed.data;
    const revision: number = input.revision || 0;
    const digest: string = projectDigest(input);
    return this.database.run(async (db): Promise<PortalProjectSummary> => {
      await db.execute(
        db
          .insert(portalProject)
          .values({
            id: input.sourceProjectId,
            name: input.name,
            summary: input.summary,
            sourceUrl:
              'https://internal.110-lab.cn/projects?project=' +
              input.sourceProjectId,
            snapshotJson: input.snapshot
              ? JSON.stringify(input.snapshot)
              : null,
            sourceRevision: revision,
            sourceDigest: digest,
          })
          .onConflictDoNothing({ target: portalProject.id }),
      );
      if (revision)
        await db.execute(
          db
            .update(portalProject)
            .set({
              name: input.name,
              summary: input.summary,
              snapshotJson: JSON.stringify(input.snapshot),
              sourceRevision: revision,
              sourceDigest: digest,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            })
            .where(
              and(
                eq(portalProject.id, input.sourceProjectId),
                lt(portalProject.sourceRevision, revision),
              ),
            ),
        );
      const rows: Row[] = await db.execute<Row>(
        db
          .select(projection)
          .from(portalProject)
          .where(eq(portalProject.id, input.sourceProjectId))
          .limit(1),
      );
      const row: Row | undefined = rows[0];
      if (!row) throw new ServiceUnavailableException('项目登记未确认');
      if (
        revision
          ? row.sourceRevision !== revision || row.sourceDigest !== digest
          : row.name !== input.name || row.summary !== input.summary
      )
        throw new ConflictException('同一项目 ID 的版本或内容已改变');
      return this.dto(row);
    });
  }
  async readCatalog(): Promise<{
    normalization: Record<string, string>;
    names: string[];
  }> {
    const rows: Row[] = await this.rows();
    const owners: Map<string, Set<string>> = new Map();
    for (const row of rows)
      for (const alias of [row.name, ...(this.snapshot(row)?.aliases || [])]) {
        const names: Set<string> = owners.get(alias) || new Set();
        names.add(row.name);
        owners.set(alias, names);
      }
    return {
      names: [...new Set(rows.map((row: Row) => row.name))],
      normalization: Object.fromEntries(
        [...owners]
          .filter(([, names]) => names.size === 1)
          .map(([alias, names]) => [alias, [...names][0]]),
      ),
    };
  }
  async normalization(): Promise<Record<string, string>> {
    return (await this.readCatalog()).normalization;
  }
  async normalizeOptions(names: string[]): Promise<string[]> {
    const { normalization: mapping, names: registered } = await this.readCatalog();
    return [
      ...new Set([
        ...names.map((name: string) => Object.hasOwn(mapping, name) ? mapping[name] : name),
        ...registered,
      ]),
    ];
  }
  async names(): Promise<string[]> {
    return [...new Set((await this.rows()).map((r: Row) => r.name))];
  }
  async list(): Promise<ManagedProject[]> {
    return (await this.rows()).map(
      (r: Row): ManagedProject => ({
        ...this.dto(r),
        sourceUrl: r.sourceUrl,
        snapshot: this.snapshot(r),
        syncedAt: new Date(r.updatedAt).toISOString(),
      }),
    );
  }
  // Read-only import feed: never mutates Bitable records or grants portal ownership.
  async catalog(): Promise<ProjectCatalogResponse> {
    const table: string = process.env.FEISHU_REQUIREMENTS_TABLE || '';
    if (!this.feishu || !table)
      throw new ServiceUnavailableException('需求分类尚未配置');
    const [fields, rows] = await Promise.all([
      this.feishu.listFields(table),
      this.rows(),
    ]);
    const covered: Set<string> = new Set(
      rows.flatMap((r: Row) => [r.name, ...(this.snapshot(r)?.aliases || [])]),
    );
    const options = fields.find((f: BaseField) => f.name === '项目')?.options;
    if (!options) throw new ServiceUnavailableException('未找到项目分类字段');
    return {
      categories: options
        .filter(
          (o) =>
            projectName.safeParse(o.name).success && !covered.has(o.name || ''),
        )
        .map((o) => ({
          id: classificationId(o.id || o.name || ''),
          name: o.name || '',
        })),
    };
  }
}
