import { Injectable, ConflictException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
export interface ConversationRow extends Record<string, unknown> {
  id: string;
  principal: string;
  app: string;
  remote_id: number;
  source_id: string;
  created_at: string;
}
interface Operation extends Record<string, unknown> {
  marker: string;
  payload_hash: string;
  state: string;
  lease_token: string;
  response_json: string | null;
}
@Injectable()
export class RelayChatwootStore {
  constructor(private readonly database: ServiceRoleDatabaseExecutor) {}
  async contacts(principal: string, app: string) {
    return (
      await this.database.run((db) =>
        db.execute<{ source_id: string; contact_id: number }>(
          sql`SELECT source_id,contact_id FROM relay_chatwoot_contact WHERE principal=${principal} AND app=${app}`,
        ),
      )
    )[0];
  }
  async saveContact(
    principal: string,
    app: string,
    source: string,
    contactId: number,
  ) {
    await this.database.run((db) =>
      db.execute(
        sql`INSERT INTO relay_chatwoot_contact(principal,app,source_id,contact_id) VALUES(${principal},${app},${source},${contactId}) ON CONFLICT(principal,app) DO UPDATE SET source_id=excluded.source_id,contact_id=excluded.contact_id`,
      ),
    );
  }
  async conversations(principal?: string) {
    return this.database.run((db) =>
      db.execute<ConversationRow>(
        sql`SELECT * FROM relay_chatwoot_conversation ${principal ? sql`WHERE principal=${principal}` : sql``} ORDER BY created_at DESC LIMIT 201`,
      ),
    );
  }
  async conversation(id: string) {
    return (
      await this.database.run((db) =>
        db.execute<ConversationRow>(
          sql`SELECT * FROM relay_chatwoot_conversation WHERE id=${id}`,
        ),
      )
    )[0];
  }
  async saveConversation(v: ConversationRow) {
    await this.database.run((db) =>
      db.execute(
        sql`INSERT INTO relay_chatwoot_conversation(id,principal,app,remote_id,source_id) VALUES(${v.id},${v.principal},${v.app},${v.remote_id},${v.source_id}) ON CONFLICT(id) DO NOTHING`,
      ),
    );
  }
  async reserve(marker: string, hash: string) {
    const lease = randomUUID();
    return this.database.run(async (db) => {
      const rows = await db.execute<Operation>(
        sql`INSERT INTO relay_chatwoot_operation(marker,payload_hash,state,lease_token,lease_expires_at) VALUES(${marker},${hash},'preparing',${lease}::uuid,NOW()+interval '1 minute') ON CONFLICT DO NOTHING RETURNING *`,
      );
      if (rows[0]) return { row: rows[0], claimed: true };
      const old = (
        await db.execute<Operation>(
          sql`SELECT * FROM relay_chatwoot_operation WHERE marker=${marker} FOR UPDATE`,
        )
      )[0];
      if (!old || old.payload_hash !== hash)
        throw new ConflictException('同一请求不能修改内容');
      if (old.state === 'failed' || old.state === 'preparing') {
        const recovered = await db.execute<Operation>(
          sql`UPDATE relay_chatwoot_operation SET state='preparing',lease_token=${lease}::uuid,lease_expires_at=NOW()+interval '1 minute',updated_at=NOW() WHERE marker=${marker} AND (state='failed' OR (state='preparing' AND lease_expires_at<NOW())) RETURNING *`,
        );
        if (recovered[0]) return { row: recovered[0], claimed: true };
      }
      return { row: old, claimed: false };
    });
  }
  async writing(row: Operation) {
    const saved = await this.database.run((db) =>
      db.execute(
        sql`UPDATE relay_chatwoot_operation SET state='writing',updated_at=NOW() WHERE marker=${row.marker} AND lease_token=${row.lease_token}::uuid AND state='preparing' AND lease_expires_at>NOW() RETURNING marker`,
      ),
    );
    if (!saved.length) throw new ConflictException('请求已失效，请重新查询');
  }
  async done(row: Operation, result: unknown) {
    const saved = await this.database.run((db) =>
      db.execute(
        sql`UPDATE relay_chatwoot_operation SET state='done',response_json=${JSON.stringify(result)},updated_at=NOW() WHERE marker=${row.marker} AND lease_token=${row.lease_token}::uuid AND state IN ('preparing','writing','unknown','done') RETURNING marker`,
      ),
    );
    if (!saved.length)
      throw new ConflictException('操作回执写入失败，请重新查询');
  }
  async fail(row: Operation, rejected: boolean) {
    await this.database.run((db) =>
      db.execute(
        sql`UPDATE relay_chatwoot_operation SET state=${rejected ? 'failed' : 'unknown'},updated_at=NOW() WHERE marker=${row.marker} AND lease_token=${row.lease_token}::uuid AND state<>'done'`,
      ),
    );
  }
}
