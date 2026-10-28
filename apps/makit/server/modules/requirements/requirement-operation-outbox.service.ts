import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { withSelfhostActor } from '../../common/selfhost/context';
import { randomUUID } from 'node:crypto';
import type {
  CurrentUserSummary,
  RequirementSummary,
} from '@shared/api.interface';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import {
  requirementBusinessEvent,
  requirementOperationOutbox,
  requirementUpdateJob,
} from '../../database/schema';
import { RequirementsCommandService } from './requirements-command.service';
import { RequirementsQueryService } from './requirements-query.service';
import { RequirementUpdateJobsService } from './requirement-update-jobs.service';
import { RequirementAiReviewService } from './requirement-ai-review.service';
import { FeishuRequestError, FeishuService } from './feishu.service';
import { linkedIds, textValue } from './requirements.model';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { OperationsTelemetryService } from '../operations/operations-telemetry.service';
import { notificationIdentities } from '../notifications/workflow-source.model';
import { backgroundErrorDiagnostic } from '../../common/utils/background-error';

interface OutboxRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  operation_id: string;
  consumer: string;
  attempts: number;
  lease_token: string;
}
interface EventRow extends Record<string, unknown> {
  id: string;
  requirement_id: string;
  actor_user_id: string;
  actor_name: string;
  before_json: string;
  after_json: string;
  fields_json: string;
  kind: string;
  occurred_at: string;
}
type Targets = Array<{ id: string; name: string; chatId: string }>;

/** Each consumer has its own durable result. Never repeats the core write. */
@Injectable()
export class RequirementOperationOutboxService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly logger = new Logger(RequirementOperationOutboxService.name);
  constructor(
    private readonly database: ServiceRoleDatabaseExecutor,
    private readonly command: RequirementsCommandService,
    private readonly query: RequirementsQueryService,
    private readonly jobs: RequirementUpdateJobsService,
    private readonly ai: RequirementAiReviewService,
    private readonly deliveries: NotificationDeliveryService,
    private readonly feishu: FeishuService,
    private readonly telemetry: OperationsTelemetryService,
  ) {}

  onModuleInit(): void {
    if (process.env.MAKIT_WORKERS_ENABLED === 'false' && process.env.COBUILD_IDENTITY_MODE !== 'local') return;
    this.timer = setInterval(() => {
      void this.scan().catch((error: unknown) =>
        this.logger.error(`operation_outbox_scan_failed ${backgroundErrorDiagnostic(error)}`),
      );
    }, 5_000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async scan(): Promise<void> {
    if (process.env.MAKIT_WORKERS_ENABLED === 'false' && process.env.COBUILD_IDENTITY_MODE !== 'local') return;
    if (this.busy) return;
    this.busy = true;
    try {
      await this.telemetry.scanner('requirement_outbox', async () => {
        const token = randomUUID();
        const rows = await this.database.run(async (db) => {
          await db.execute(sql`UPDATE ${requirementOperationOutbox} SET status=CASE WHEN consumer='history' THEN 'unknown' WHEN attempts>=8 THEN 'failed' ELSE 'retry_wait' END,
            finished_at=CASE WHEN consumer<>'history' AND attempts>=8 THEN CURRENT_TIMESTAMP ELSE NULL END,
            error_code='consumer_lease_expired',lease_token=NULL,lease_expires_at=NULL
            WHERE status='running' AND lease_expires_at<=CURRENT_TIMESTAMP`);
          return db.execute<OutboxRow>(sql`WITH candidates AS (
            SELECT candidate.id FROM ${requirementOperationOutbox} candidate
            JOIN ${requirementUpdateJob} current_job ON current_job.id=candidate.operation_id
            WHERE candidate.status IN('pending','retry_wait')
              AND candidate.available_at<=CURRENT_TIMESTAMP AND candidate.attempts<8
              AND (candidate.consumer<>'notification' OR NOT EXISTS (
                SELECT 1 FROM ${requirementOperationOutbox} previous
                JOIN ${requirementUpdateJob} previous_job ON previous_job.id=previous.operation_id
                WHERE previous.consumer='notification' AND previous.status<>'succeeded'
                  AND previous_job.requirement_id=current_job.requirement_id
                  AND previous_job.operation_sequence<current_job.operation_sequence))
              ORDER BY current_job.operation_sequence,candidate.id LIMIT 8 FOR UPDATE OF candidate SKIP LOCKED)
            UPDATE ${requirementOperationOutbox} o SET status='running',attempts=attempts+1,lease_token=${token}::uuid,
              lease_expires_at=CURRENT_TIMESTAMP+interval '5 minutes',_updated_at=CURRENT_TIMESTAMP
            FROM candidates c WHERE o.id=c.id RETURNING o.*`);
        });
        await Promise.all(rows.map((row) => this.consume(row)));
        await this.reconcileHistory();
      });
    } finally {
      this.busy = false;
    }
  }

  private async consume(row: OutboxRow): Promise<void> {
    let attemptedHistoryWrite = false;
    try {
      const event = (
        await this.database.run((db) =>
          db.execute<EventRow>(sql`
        SELECT * FROM ${requirementBusinessEvent} WHERE id=${row.event_id}::uuid`),
        )
      )[0];
      if (!event) throw new Error('event_missing');
      const before: RequirementSummary = JSON.parse(event.before_json);
      const after: RequirementSummary = JSON.parse(event.after_json);
      if (process.env.COBUILD_IDENTITY_MODE === 'local' && ['review', 'notification'].includes(row.consumer)) {
        // Complete the consumer as intentionally disabled, never as delivered.
        await this.finish(row, 'succeeded', 'integration_disabled');
        return;
      }
      if (row.consumer === 'history') {
        if (!(await this.command.hasConfirmedActivity(row.operation_id))) {
          const actor = await this.jobs.currentActor(event.actor_user_id);
          attemptedHistoryWrite = true;
          await withSelfhostActor(actor, () => this.command.recordConfirmedActivity(
            before,
            after,
            actor,
            JSON.parse(event.fields_json),
            event.kind === 'status-transition' ? 'status-transition' : 'edit',
            row.operation_id,
          ));
        }
      } else if (row.consumer === 'review') {
        const actor: CurrentUserSummary = await this.jobs.currentActor(
          event.actor_user_id,
        );
        // Review current authoritative material. An old outbox item must not
        // resurrect an old material version after a newer edit.
        const latest = await this.query.requirementByIdForWorker(
          event.requirement_id,
          actor,
        );
        await this.ai.onRequirementUpdated(before, latest, actor);
      } else if (row.consumer === 'notification') {
        const targets = await this.captureTargets(event, after);
        const [notificationBefore, notificationAfter] = await notificationIdentities([before, after],
          (id) => this.feishu.getOpenIdByEmployeeId(id));
        await this.deliveries.recordRequirementEvent({
          eventId: `operation:${row.operation_id}`,
          operationId: row.operation_id,
          requirementId: event.requirement_id,
          occurredAt: String(event.occurred_at),
          before: notificationBefore,
          after: notificationAfter,
          fields: JSON.parse(event.fields_json),
          actor: { name: event.actor_name },
          iterationTargets: targets,
        });
      } else if (row.consumer === 'cache') {
        await this.query.commitRequirement(
          event.requirement_id,
          undefined,
          row.operation_id,
        );
      } else throw new Error('consumer_not_supported');
      await this.finish(row, 'succeeded', null);
    } catch (error) {
      this.logger.error(
        `operation_outbox_consumer_failed operation=${row.operation_id} consumer=${row.consumer} attempt=${row.attempts} ${backgroundErrorDiagnostic(error)}`,
      );
      const unknown =
        attemptedHistoryWrite &&
        !(error instanceof FeishuRequestError && error.remoteRejected);
      const permanent =
        error instanceof FeishuRequestError &&
        /(?:_403|_401|_999916\d*)$/u.test(error.errorCode);
      await this.finish(
        row,
        unknown
          ? 'unknown'
          : permanent || row.attempts >= 8
            ? 'failed'
            : 'retry_wait',
        unknown
          ? 'history_result_unknown'
          : permanent
            ? 'dependency_permission'
            : 'consumer_failed',
      );
    }
  }

  private async finish(
    row: OutboxRow,
    status: string,
    error: string | null,
  ): Promise<void> {
    await this.database.run((db) =>
      db.execute(sql`UPDATE ${requirementOperationOutbox}
      SET status=${status},error_code=${error},lease_token=NULL,lease_expires_at=NULL,
        finished_at=CASE WHEN ${status} IN('succeeded','failed') THEN CURRENT_TIMESTAMP ELSE NULL END,
        available_at=CURRENT_TIMESTAMP+(${Math.min(300, 2 ** row.attempts * 5)}::integer * interval '1 second'),
        _updated_at=CURRENT_TIMESTAMP
      WHERE id=${row.id}::uuid AND status='running' AND lease_token=${row.lease_token}::uuid
        AND lease_expires_at>CURRENT_TIMESTAMP`),
    );
  }

  private async reconcileHistory(): Promise<void> {
    const rows = await this.database.run((db) =>
      db.execute<OutboxRow>(sql`
      SELECT * FROM ${requirementOperationOutbox} WHERE consumer='history' AND status='unknown' LIMIT 10`),
    );
    for (const row of rows) {
      // Absence is not proof of non-delivery. Never create from reconciliation.
      if (await this.command.hasConfirmedActivity(row.operation_id)) {
        await this.database.run((db) =>
          db.execute(sql`UPDATE ${requirementOperationOutbox}
          SET status='succeeded',error_code=NULL,finished_at=CURRENT_TIMESTAMP,_updated_at=CURRENT_TIMESTAMP
          WHERE id=${row.id}::uuid AND status='unknown'`),
        );
      }
    }
  }

  private async captureTargets(
    event: EventRow,
    after: RequirementSummary,
  ): Promise<Targets> {
    const snapshot = JSON.parse(event.after_json) as RequirementSummary & {
      notificationTargets?: Targets;
    };
    if (snapshot.notificationTargets) return snapshot.notificationTargets;
    const targets: Targets = [];
    if (after.iterationIds.length) {
      const table =
        process.env.FEISHU_BINDINGS_TABLE?.trim() || 'tblNIF6ZJKoTYbdk';
      const bindings = await this.feishu.searchRecords(table, {
        conjunction: 'and',
        conditions: [
          { fieldName: '是否启用', operator: 'is', value: ['true'] },
        ],
      });
      for (const binding of bindings) {
        const id = linkedIds(binding.fields['绑定迭代']).find((value) =>
          after.iterationIds.includes(value),
        );
        const chatId = textValue(binding.fields['群聊ID']);
        if (id && chatId)
          targets.push({
            id,
            name: textValue(binding.fields['群名称']),
            chatId,
          });
      }
    }
    const rows = await this.database.run((db) =>
      db.execute<{ after_json: string }>(sql`
      UPDATE ${requirementBusinessEvent} SET after_json=
        CASE WHEN after_json::jsonb ? 'notificationTargets' THEN after_json
        ELSE jsonb_set(after_json::jsonb,'{notificationTargets}',${JSON.stringify(targets)}::jsonb)::text END
      WHERE id=${event.id}::uuid RETURNING after_json`),
    );
    return JSON.parse(rows[0].after_json).notificationTargets;
  }
}
