import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import type {
  CurrentUserSummary,
  MutationResult,
  RequirementArchiveListResponse,
  RequirementArchiveSummary,
  RequirementSummary,
} from '@shared/api.interface';
import {
  type BaseRecord,
  type BaseRecordSearchFilter,
  FeishuService,
} from './feishu.service';
import { RequirementAccessService } from './requirement-access.service';
import { linkedIds } from './requirements.model';
import { RequirementsQueryService } from './requirements-query.service';
import { iterationAssignmentError } from '../../../shared/iteration-assignment';

interface RequirementArchiveRow extends Record<string, unknown> {
  requirement_id: string;
  requirement_code: string;
  requirement_title: string;
  archived_at: Date | string;
  archived_by_name: string;
  deletion_status: 'idle' | 'deleting' | 'failed';
  deletion_error: string | null;
}

interface RequirementDeletionClaimRow extends Record<string, unknown> {
  claim_token: string;
}

interface AffectedCountRow extends Record<string, unknown> {
  affected_count: number;
}

interface AppliedRow extends Record<string, unknown> {
  applied: boolean;
}

@Injectable()
export class RequirementArchiveService {
  private readonly logger: Logger = new Logger(RequirementArchiveService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly feishu: FeishuService,
    private readonly query: RequirementsQueryService,
    private readonly access: RequirementAccessService,
  ) {}

  /** Fetches the complete active archive set in one database round trip. */
  async activeIds(): Promise<Set<string>> {
    const rows = await this.db.execute<RequirementArchiveRow>(sql`
      SELECT requirement_id FROM requirement_archive_active_ids()
    `);
    return new Set(
      rows.map((row: RequirementArchiveRow): string => row.requirement_id),
    );
  }

  async isArchived(requirementId: string): Promise<boolean> {
    return (await this.activeIds()).has(requirementId);
  }

  async assertActive(
    requirementId: string,
    archivedIds?: ReadonlySet<string>,
  ): Promise<void> {
    if (
      archivedIds
        ? archivedIds.has(requirementId)
        : await this.isArchived(requirementId)
    ) {
      throw new ConflictException('该需求已归档，请先恢复后再操作');
    }
  }

  async list(
    actor: CurrentUserSummary,
  ): Promise<RequirementArchiveListResponse> {
    this.access.assertCanListArchive(actor);
    const rows = await this.db.execute<RequirementArchiveRow>(sql`
      SELECT
        requirement_id,
        requirement_code,
        requirement_title,
        archived_at,
        archived_by_name,
        deletion_status,
        deletion_error
      FROM requirement_archive_list_v2()
    `);
    return {
      items: rows.map(
        (row: RequirementArchiveRow): RequirementArchiveSummary => ({
          requirementId: row.requirement_id,
          code: row.requirement_code,
          title: row.requirement_title,
          archivedAt: new Date(row.archived_at).toISOString(),
          archivedByName: row.archived_by_name,
          deletionStatus: row.deletion_status,
          deletionError: row.deletion_error || '',
        }),
      ),
    };
  }

  async archive(
    requirement: RequirementSummary,
    actor: CurrentUserSummary,
  ): Promise<MutationResult> {
    this.access.assertCanArchive(requirement, actor);
    if (await this.isArchived(requirement.id)) {
      throw new ConflictException('该需求已经归档');
    }
    let archived: AppliedRow[];
    try {
      archived = await this.db.execute<AppliedRow>(sql`
        SELECT requirement_archive_upsert(
          ${requirement.id},
          ${requirement.code},
          ${requirement.title},
          ${actor.miaodaUserId},
          ${actor.name}
        ) AS applied
      `);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('requirement has active update jobs')
      ) {
        throw new ConflictException('需求仍有更新任务在执行，请稍后再归档');
      }
      throw error;
    }
    if (archived[0]?.applied !== true) {
      throw new ConflictException('需求归档状态已变化，请刷新后重试');
    }
    this.invalidateRequirementCaches();
    return {
      success: true,
      message: `需求“${requirement.title}”已归档`,
      recordId: requirement.id,
      updatedFields: ['归档状态'],
    };
  }

  async restore(
    requirementId: string,
    actor: CurrentUserSummary,
  ): Promise<MutationResult> {
    this.access.assertCanRestore(actor);
    const archive: RequirementArchiveRow =
      await this.activeArchive(requirementId);
    if (archive.deletion_status !== 'idle') {
      throw new ConflictException(
        archive.deletion_status === 'deleting'
          ? '该需求正在永久删除，不能恢复'
          : '该需求已开始永久删除且存在未完成步骤，请继续删除，不能恢复',
      );
    }
    let requirement: RequirementSummary;
    try {
      // Ignore the archive filter only for this explicitly authorized restore.
      // The source record and its current iteration rules must still be read.
      requirement = await this.query.requirementByIdAs(
        requirementId,
        actor,
        new Set(),
      );
    } catch (error) {
      if (error instanceof NotFoundException)
        throw new ConflictException('原需求记录已不存在，无法恢复');
      throw error;
    }
    const assignmentError = iterationAssignmentError(requirement.iterationIds);
    if (assignmentError) throw new ConflictException(assignmentError);
    if (
      requirement.workflow &&
      !requirement.workflow.statuses.includes(requirement.status)
    )
      throw new ConflictException(
        `当前迭代已停用“${requirement.status}”，请先恢复兼容的迭代规则再恢复需求`,
      );
    await this.query.assertWorkflowVersion(requirement);
    const restored = await this.db.execute<AffectedCountRow>(sql`
      SELECT requirement_archive_restore(
        ${requirementId},
        ${actor.miaodaUserId},
        ${actor.name}
      ) AS affected_count
    `);
    if (Number(restored[0]?.affected_count || 0) !== 1) {
      throw new ConflictException('需求归档状态已变化，请刷新后重试');
    }
    this.invalidateRequirementCaches();
    return {
      success: true,
      message: `需求“${archive.requirement_title}”已恢复`,
      recordId: requirementId,
      updatedFields: ['归档状态'],
    };
  }

  async permanentlyDelete(
    requirementId: string,
    actor: CurrentUserSummary,
  ): Promise<MutationResult> {
    this.access.assertCanPermanentlyDelete(actor);
    const archive: RequirementArchiveRow =
      await this.activeArchive(requirementId);
    const claimRows = await this.db.execute<RequirementDeletionClaimRow>(sql`
      SELECT claim_token
      FROM requirement_archive_delete_claim(
        ${requirementId},
        ${actor.miaodaUserId},
        ${actor.name},
        ${300}::integer
      )
    `);
    const claimToken: string = claimRows[0]?.claim_token || '';
    if (!claimToken) {
      throw new ConflictException('该需求正在被其他操作永久删除，请稍后刷新');
    }
    const relatedTables: Array<{
      tableId: string;
      filter: BaseRecordSearchFilter;
      matches: (record: BaseRecord) => boolean;
    }> = [
      {
        tableId: this.query.table('FEISHU_COMMENTS_TABLE'),
        filter: this.linkedRecordFilter('需求', requirementId),
        matches: (record: BaseRecord): boolean =>
          linkedIds(record.fields['需求']).includes(requirementId),
      },
      {
        tableId: this.query.table('FEISHU_ACCEPTANCE_TABLE'),
        filter: this.linkedRecordFilter('需求', requirementId),
        matches: (record: BaseRecord): boolean =>
          linkedIds(record.fields['需求']).includes(requirementId),
      },
      {
        tableId: this.query.table('FEISHU_RELATIONS_TABLE'),
        filter: {
          conjunction: 'or',
          conditions: [
            {
              fieldName: '源需求',
              operator: 'contains',
              value: [requirementId],
            },
            {
              fieldName: '目标需求',
              operator: 'contains',
              value: [requirementId],
            },
          ],
        },
        matches: (record: BaseRecord): boolean =>
          linkedIds(record.fields['源需求']).includes(requirementId) ||
          linkedIds(record.fields['目标需求']).includes(requirementId),
      },
      {
        tableId: this.query.table('FEISHU_COLLABORATION_TABLE'),
        filter: this.linkedRecordFilter('需求', requirementId),
        matches: (record: BaseRecord): boolean =>
          linkedIds(record.fields['需求']).includes(requirementId),
      },
    ];
    try {
      for (const table of relatedTables) {
        const records: BaseRecord[] = await this.feishu.searchRecords(
          table.tableId,
          table.filter,
        );
        const relatedIds: string[] = records
          .filter(table.matches)
          .map((record: BaseRecord): string => record.record_id);
        for (const relatedId of relatedIds) {
          await this.renewDeletionLease(requirementId, claimToken);
          await this.feishu.deleteRecord(table.tableId, relatedId);
        }
      }
      // A prior attempt may have deleted the Base record and then failed before
      // the local audit row was marked complete. Re-read the authoritative
      // table so a leased retry can finish safely.
      const requirementsTableId: string = this.query.table(
        'FEISHU_REQUIREMENTS_TABLE',
      );
      const requirementStillExists: boolean = (
        await this.feishu.listRecords(requirementsTableId)
      ).some(
        (record: BaseRecord): boolean => record.record_id === requirementId,
      );
      if (requirementStillExists) {
        await this.renewDeletionLease(requirementId, claimToken);
        await this.feishu.deleteRecord(requirementsTableId, requirementId);
      }
      const completed = await this.db.execute<AffectedCountRow>(sql`
        SELECT requirement_archive_delete_complete(
          ${requirementId},
          ${claimToken}::uuid,
          ${actor.miaodaUserId},
          ${actor.name}
        ) AS affected_count
      `);
      if (Number(completed[0]?.affected_count || 0) !== 1) {
        throw new ConflictException('永久删除租约已失效，请刷新后重试');
      }
    } catch (error) {
      try {
        await this.db.execute(sql`
          SELECT requirement_archive_delete_fail(
            ${requirementId},
            ${claimToken}::uuid,
            ${error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)},
            ${actor.miaodaUserId},
            ${actor.name}
          )
        `);
      } catch (markFailedError) {
        this.logger.error(
          `记录需求 ${requirementId} 永久删除失败状态时出错`,
          markFailedError instanceof Error
            ? markFailedError.stack
            : String(markFailedError),
        );
      }
      throw error;
    }
    this.invalidateRequirementCaches();
    return {
      success: true,
      message: `需求“${archive.requirement_title}”已永久删除`,
      recordId: requirementId,
      updatedFields: ['需求及关联数据'],
    };
  }

  private async activeArchive(
    requirementId: string,
  ): Promise<RequirementArchiveRow> {
    const rows = await this.db.execute<RequirementArchiveRow>(sql`
      SELECT
        requirement_id,
        requirement_code,
        requirement_title,
        archived_at,
        archived_by_name,
        deletion_status,
        deletion_error
      FROM requirement_archive_list_v2()
      WHERE requirement_id = ${requirementId}
      LIMIT 1
    `);
    if (!rows[0]) throw new NotFoundException('未找到已归档需求');
    return rows[0];
  }

  private async renewDeletionLease(
    requirementId: string,
    claimToken: string,
  ): Promise<void> {
    const rows = await this.db.execute<AffectedCountRow>(sql`
      SELECT requirement_archive_delete_renew(
        ${requirementId},
        ${claimToken}::uuid,
        ${300}::integer
      ) AS affected_count
    `);
    if (Number(rows[0]?.affected_count || 0) !== 1) {
      throw new ConflictException('永久删除租约已失效，请刷新后重试');
    }
  }

  private linkedRecordFilter(
    fieldName: string,
    requirementId: string,
  ): BaseRecordSearchFilter {
    return {
      conjunction: 'and',
      conditions: [
        {
          fieldName,
          operator: 'contains',
          value: [requirementId],
        },
      ],
    };
  }

  private invalidateRequirementCaches(): void {
    this.query.invalidate();
    this.query.invalidateDetailSupport();
  }
}
