import { Injectable, ConflictException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
export interface IntakeRow extends Record<string, unknown> {
  source_id: string;
  conversation_id: string;
  marker: string;
  payload_hash: string;
  payload_json: string;
  actor_user_id: string;
  state: 'preparing' | 'writing' | 'unknown' | 'failed' | 'linked';
  lease_token: string;
  requirement_id: string | null;
}
@Injectable()
export class RelayIntakeStore {
  constructor(private readonly database: ServiceRoleDatabaseExecutor) {}
  async read(
    source: string,
    conversation: string,
  ): Promise<IntakeRow | undefined> {
    return (
      await this.database.run((db) =>
        db.execute<IntakeRow>(sql`SELECT * FROM relay_ticket_intake
      WHERE source_id=${source} AND conversation_id=${conversation}`),
      )
    )[0];
  }
  async byMarker(marker: string): Promise<IntakeRow | undefined> {
    return (
      await this.database.run((db) =>
        db.execute<IntakeRow>(
          sql`SELECT * FROM relay_ticket_intake WHERE marker=${marker}`,
        ),
      )
    )[0];
  }
  async reserve(
    source: string,
    conversation: string,
    marker: string,
    hash: string,
    payload: string,
    actor: string,
  ) {
    const token = randomUUID();
    return this.database.run(async (db) => {
      const inserted =
        await db.execute<IntakeRow>(sql`INSERT INTO relay_ticket_intake
        (source_id,conversation_id,marker,payload_hash,payload_json,actor_user_id,state,lease_token,lease_expires_at)
        VALUES (${source},${conversation},${marker},${hash},${payload},${actor},'preparing',${token}::uuid,CURRENT_TIMESTAMP+interval '5 minutes')
        ON CONFLICT(source_id,conversation_id) DO NOTHING RETURNING *`);
      if (inserted[0]) return { row: inserted[0], claimed: true };
      // Only pre-write/rejected work is safe to claim again; uncertain writes are never replayed.
      const retried =
        await db.execute<IntakeRow>(sql`UPDATE relay_ticket_intake SET state='preparing',
        payload_hash=${hash},payload_json=${payload},actor_user_id=${actor},
        lease_token=${token}::uuid, lease_expires_at=CURRENT_TIMESTAMP+interval '5 minutes', updated_at=CURRENT_TIMESTAMP
        WHERE source_id=${source} AND conversation_id=${conversation}
          AND (state='failed' OR (state='preparing' AND lease_expires_at<CURRENT_TIMESTAMP)) RETURNING *`);
      if (retried[0]) return { row: retried[0], claimed: true };
      const row = (
        await db.execute<IntakeRow>(
          sql`SELECT * FROM relay_ticket_intake WHERE source_id=${source} AND conversation_id=${conversation}`,
        )
      )[0];
      if (!row) throw new ConflictException('建单状态发生变化，请重新查询');
      return { row, claimed: false };
    });
  }
  async writing(row: IntakeRow): Promise<void> {
    const rows = await this.database.run((db) =>
      db.execute(sql`UPDATE relay_ticket_intake SET state='writing',updated_at=CURRENT_TIMESTAMP
      WHERE marker=${row.marker} AND lease_token=${row.lease_token}::uuid AND state='preparing'
        AND lease_expires_at>CURRENT_TIMESTAMP RETURNING marker`),
    );
    if (!rows.length) throw new ConflictException('建单请求已失效，请重新查询');
  }
  async finish(row: IntakeRow, recordId: string): Promise<void> {
    const rows = await this.database.run((db) =>
      db.execute(sql`UPDATE relay_ticket_intake SET state='linked',
      requirement_id=${recordId},error_code=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE marker=${row.marker} AND lease_token=${row.lease_token}::uuid
        AND (requirement_id IS NULL OR requirement_id=${recordId}) RETURNING marker`),
    );
    if (!rows.length) throw new ConflictException('建单关联版本不一致');
  }
  async fail(
    row: IntakeRow,
    state: 'failed' | 'unknown',
    code: string,
  ): Promise<void> {
    await this.database.run((db) =>
      db.execute(sql`UPDATE relay_ticket_intake SET state=${state}, error_code=${code},updated_at=CURRENT_TIMESTAMP
      WHERE marker=${row.marker} AND lease_token=${row.lease_token}::uuid AND state<>'linked'`),
    );
  }
}
