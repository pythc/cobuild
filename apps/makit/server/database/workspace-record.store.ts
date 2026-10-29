import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { RequestContextService } from '../common/selfhost/context';
import { assertProjectWrites } from '../common/selfhost/project-write-policy';
import type {
  WorkspaceField, WorkspaceRecord, WorkspaceRecordFilter, WorkspaceUserIdType,
} from './workspace-record.types';

export const WORKSPACE_SQL = Symbol('WORKSPACE_SQL');

interface StoredRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

/** PostgreSQL is authoritative. No remote fallback or dual writes are allowed. */
@Injectable()
export class WorkspaceRecordStore {
  constructor(@Inject(WORKSPACE_SQL) private readonly client: Sql, @Optional() private readonly context?: RequestContextService) {}

  private async writable(tx:TransactionSql,collectionId:string,rows:Array<Record<string,unknown>>){
    if(process.env.COBUILD_IDENTITY_MODE!=='local')return;
    const fields=[...rows];
    if([process.env.FEISHU_COMMENTS_TABLE,process.env.FEISHU_ACCEPTANCE_TABLE].includes(collectionId)&&rows.length){
      // Comments and acceptance items belong to their requirement's project.
      // Resolve both old and new links before any mutation, in the same batch.
      const parents=await tx<StoredRecord[]>`SELECT record_id,fields FROM makit_record
        WHERE collection_id=${process.env.FEISHU_REQUIREMENTS_TABLE!} AND record_id IN (
          SELECT unnest(makit_cell_values(value->'需求')) FROM jsonb_array_elements(${tx.json(rows as never)})
        )`;
      fields.push(...parents.map(r=>r.fields));
    }
    await assertProjectWrites(fields);
  }

  async openIdByEmployeeId(employeeId: string): Promise<string | null> {
    const rows = await this.client<{ open_id: string }[]>`
      SELECT open_id FROM makit_directory WHERE employee_id = ${employeeId} AND active
    `;
    return rows[0]?.open_id || null;
  }

  async listFields(collectionId: string): Promise<WorkspaceField[]> {
    const rows = await this.client<{ fields: WorkspaceField[] }[]>`
      SELECT fields FROM makit_collection WHERE id = ${collectionId}
    `;
    if (!rows[0]) throw new NotFoundException('业务数据集不存在');
    return rows[0].fields;
  }

  private async present(
    collectionId: string, rows: StoredRecord[], userIdType: WorkspaceUserIdType,
  ): Promise<WorkspaceRecord[]> {
    // Canonical person cells use open_id. Employee IDs are resolved only for
    // person fields, never by recursively rewriting arbitrary user text.
    if (userIdType === 'open_id' || !rows.length) return rows;
    const directory = await this.client<{ open_id: string; employee_id: string }[]>`
      SELECT open_id, '' AS employee_id FROM makit_audit_principal
      UNION ALL SELECT open_id, employee_id FROM makit_directory
    `;
    const employeeIds = new Map(directory.map((person) => [person.open_id, person.employee_id]));
    const fields = new Set((await this.listFields(collectionId))
      .filter((field) => ['11', '1003', '1004'].includes(field.type)).map((field) => field.name));
    return rows.map((row) => ({
      record_id: row.record_id,
      fields: Object.fromEntries(Object.entries(row.fields).map(([name, value]) => {
        const convert = (person: Record<string, unknown>) => {
              const id = employeeIds.get(String(person.id));
              if (id === undefined) throw new NotFoundException('历史组织身份未完成迁移');
              return { ...person, id };
        };
        return [name, !fields.has(name) || !value ? value : Array.isArray(value)
          ? value.map(convert) : convert(value as Record<string, unknown>)];
      })),
    }));
  }

  async listRecords(
    collectionId: string, fieldNames?: string[], userIdType: WorkspaceUserIdType = 'open_id',
  ): Promise<WorkspaceRecord[]> {
    await this.listFields(collectionId);
    const rows = await this.client<StoredRecord[]>`
      SELECT record_id, fields FROM makit_record
      WHERE collection_id = ${collectionId} ORDER BY ordinal, record_id
    `;
    const presented = await this.present(collectionId, rows, userIdType);
    return fieldNames ? presented.map((row) => ({
      record_id: row.record_id,
      fields: Object.fromEntries(fieldNames.filter((name) => name in row.fields)
        .map((name) => [name, row.fields[name]])),
    })) : presented;
  }

  async getRecord(
    collectionId: string, recordId: string, userIdType: WorkspaceUserIdType = 'open_id',
  ): Promise<WorkspaceRecord> {
    const rows = await this.client<StoredRecord[]>`
      SELECT record_id, fields FROM makit_record
      WHERE collection_id = ${collectionId} AND record_id = ${recordId}
    `;
    if (!rows[0]) throw new NotFoundException('记录不存在');
    return (await this.present(collectionId, rows, userIdType))[0];
  }

  private async searchPredicate(collectionId: string, filter: WorkspaceRecordFilter, userIdType: WorkspaceUserIdType) {
    const definitions = new Map((await this.listFields(collectionId)).map((field) => [field.name, field]));
    const people: Array<{ employee_id: string; open_id: string }> = userIdType === 'user_id'
      ? await this.client<{ employee_id: string; open_id: string }[]>`SELECT employee_id, open_id FROM makit_directory`
      : [];
    const openIds = new Map(people.map((person) => [person.employee_id, person.open_id] as const));
    // Values and field names are parameters, including apostrophes and Unicode.
    // The predicate follows the legacy scalar/person/link semantics; JSON text
    // substring matching would make rec1 incorrectly match rec10.
    const clauses = filter.conditions.map((condition) => {
      const definition = definitions.get(condition.fieldName);
      if (!definition) throw new BadRequestException('筛选字段不存在');
      const cell = this.client`makit_cell_values(fields->${condition.fieldName})`;
      const empty = this.client`cardinality(${cell}) = 0`;
      if (condition.operator === 'isEmpty') return empty;
      if (condition.operator === 'isNotEmpty') return this.client`NOT (${empty})`;
      const values = (condition.value || []).map((value) => definition.type === '11' && userIdType === 'user_id'
        ? openIds.get(value) || value : value);
      const contains = ['contains', 'doesNotContain'].includes(condition.operator);
      const found = contains && definition.type === '1'
        ? (values.length ? values.map((value) => this.client`EXISTS (
            SELECT 1 FROM unnest(${cell}) AS text_value WHERE strpos(lower(text_value), lower(${value})) > 0
          )`).reduce((a, b) => this.client`(${a}) OR (${b})`) : this.client`FALSE`)
        : !values.length ? this.client`FALSE` : contains
        ? this.client`${cell} && ${this.client.array(values, 25)}`
        : this.client`${cell} @> ${this.client.array(values, 25)}`;
      return condition.operator === 'isNot' || condition.operator === 'doesNotContain'
        ? this.client`NOT (${found})` : found;
    });
    const predicate = clauses.length
      ? clauses.reduce((left, right) => filter.conjunction === 'and'
          ? this.client`(${left}) AND (${right})` : this.client`(${left}) OR (${right})`)
      : this.client`TRUE`;
    // postgres fragments are thenables; wrapping prevents async return from
    // accidentally executing this predicate as an independent SQL statement.
    return { predicate };
  }

  async searchRecords(
    collectionId: string, filter: WorkspaceRecordFilter,
    userIdType: WorkspaceUserIdType = 'open_id',
  ): Promise<WorkspaceRecord[]> {
    const { predicate } = await this.searchPredicate(collectionId, filter, userIdType);
    const rows = await this.client<StoredRecord[]>`
      SELECT record_id, fields FROM makit_record
      WHERE collection_id = ${collectionId} AND (${predicate}) ORDER BY ordinal, record_id
    `;
    return this.present(collectionId, rows, userIdType);
  }

  async searchRecordPage(
    collectionId: string, filter: WorkspaceRecordFilter, fieldNames: string[], pageSize = 500,
  ): Promise<{ items: WorkspaceRecord[]; hasMore: boolean }> {
    const limit = Math.min(500, Math.max(1, Math.trunc(pageSize) || 500));
    const { predicate } = await this.searchPredicate(collectionId, filter, 'user_id');
    const stored = await this.client<StoredRecord[]>`
      SELECT record_id, fields FROM makit_record WHERE collection_id = ${collectionId} AND (${predicate})
      ORDER BY CASE WHEN jsonb_typeof(fields->'创建时间') = 'number' THEN (fields->>'创建时间')::numeric ELSE 0 END DESC,
        ordinal DESC, record_id LIMIT ${limit + 1}
    `;
    const rows = await this.present(collectionId, stored, 'user_id');
    return {
      items: rows.slice(0, limit).map((row) => ({
        record_id: row.record_id,
        fields: Object.fromEntries(fieldNames.filter((name) => name in row.fields)
          .map((name) => [name, row.fields[name]])),
      })),
      hasMore: rows.length > limit,
    };
  }

  private async canonicalFields(
    collectionId: string, input: Record<string, unknown>, userIdType: WorkspaceUserIdType,
  ): Promise<Record<string, unknown>> {
    const definitions = await this.listFields(collectionId);
    const result = { ...input };
    for (const field of definitions.filter((field) => field.type === '11')) {
      const value = result[field.name];
      if (!Array.isArray(value)) continue;
      result[field.name] = await Promise.all(value.map(async (person: { id: string }) => {
        const rows = await this.client<{ open_id: string; employee_id: string; name: string }[]>`
          SELECT open_id, employee_id, name FROM makit_directory
          WHERE ${userIdType === 'user_id'
            ? this.client`employee_id = ${person.id}` : this.client`open_id = ${person.id}`}
        `;
        if (!rows[0]) throw new NotFoundException('所选组织成员不存在，请刷新通讯录');
        return { id: rows[0].open_id, name: rows[0].name };
      }));
    }
    return result;
  }

  private async auditPerson(): Promise<{id:string;name:string} | null> {
    const principal=this.context?.current?.auditPrincipal;
    if (principal) {
      const [bot]=await this.client<{open_id:string;name:string}[]>`SELECT open_id,name FROM makit_audit_principal WHERE open_id=${principal}`;
      if (!bot) throw new NotFoundException('自动化操作身份未配置');
      return {id:bot.open_id,name:bot.name};
    }
    const id=this.context?.current?.employeeId;
    if (!id) return null;
    const [person]=await this.client<{open_id:string;name:string}[]>`SELECT open_id,name FROM makit_directory WHERE employee_id=${id} AND active`;
    return person ? {id:person.open_id,name:person.name} : null;
  }

  async createRecord(
    collectionId: string, fields: Record<string, unknown>, userIdType: WorkspaceUserIdType = 'open_id',
  ): Promise<WorkspaceRecord> {
    const canonical = await this.canonicalFields(collectionId, fields, userIdType);
    const recordId = `rec${randomBytes(12).toString('hex')}`;
    const definitions = await this.listFields(collectionId);
    const actor = await this.auditPerson();
    await this.client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(11020261020)`;
      await this.writable(tx,collectionId,[canonical]);
      const sequence = await tx<{ value: string }[]>`
        UPDATE makit_collection SET next_number = next_number + 1
        WHERE id = ${collectionId} RETURNING next_number - 1 AS value
      `;
      const now = Date.now();
      for (const field of definitions) {
        if (field.type === '1001' || field.type === '1002') canonical[field.name] = now;
        if (actor && ['1003','1004'].includes(field.type)) canonical[field.name]=actor;
        if (field.type === '1005') {
          const format = field.property?.auto_serial;
          if (format?.type !== 'custom') canonical[field.name] = Number(sequence[0].value);
          else canonical[field.name] = (format.options || []).map((part) => {
            if (part.type === 'fixed_text') return part.value;
            if (part.type === 'system_number') return String(sequence[0].value).padStart(Number(part.value), '0');
            if (part.type === 'created_time' && part.value === 'yyyyMMdd') {
              const date = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
              }).format(new Date(now));
              return date.replaceAll('-', '');
            }
            throw new Error('尚未支持的数据编号规则');
          }).join('');
        }
      }
      await tx`
        INSERT INTO makit_record (collection_id, record_id, fields)
        VALUES (${collectionId}, ${recordId}, ${tx.json(canonical as never)})
      `;
    });
    return this.getRecord(collectionId, recordId, userIdType);
  }

  private async patch(
    tx: TransactionSql, collectionId: string, recordId: string, fields: Record<string, unknown>,
  ): Promise<void> {
    const rows = await tx`
      UPDATE makit_record SET fields = fields || ${tx.json(fields as never)},
        version = version + 1, updated_at = clock_timestamp()
      WHERE collection_id = ${collectionId} AND record_id = ${recordId} RETURNING record_id
    `;
    if (!rows.length) throw new NotFoundException('记录不存在');
  }

  async updateRecord(
    collectionId: string, recordId: string, fields: Record<string, unknown>,
    userIdType: WorkspaceUserIdType = 'open_id',
  ): Promise<WorkspaceRecord> {
    await this.batchUpdateRecords(collectionId, [{ recordId, fields }], userIdType);
    return this.getRecord(collectionId, recordId, userIdType);
  }

  async batchUpdateRecords(
    collectionId: string,
    records: Array<{ recordId: string; fields: Record<string, unknown> }>,
    userIdType: WorkspaceUserIdType = 'open_id',
  ): Promise<WorkspaceRecord[]> {
    const definitions = await this.listFields(collectionId);
    const actor = await this.auditPerson();
    const canonical = await Promise.all(records.map(async (record) => {
      const fields = await this.canonicalFields(collectionId, record.fields, userIdType);
      for (const field of definitions.filter((field) => field.type === '1002')) fields[field.name] = Date.now();
      for (const field of definitions.filter((field) => field.type === '1004')) if(actor) fields[field.name]=actor;
      return { ...record, fields };
    }));
    await this.client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(11020261020)`;
      // One transaction prevents partially successful bulk updates.
      if(canonical.length){
        const previous=await tx<StoredRecord[]>`SELECT record_id,fields FROM makit_record
          WHERE collection_id=${collectionId} AND record_id IN ${tx(canonical.map(r=>r.recordId))} FOR UPDATE`;
        await this.writable(tx,collectionId,[...previous.map(r=>r.fields),...canonical.map(r=>r.fields)]);
      }
      for (const record of canonical) await this.patch(tx, collectionId, record.recordId, record.fields);
    });
    return Promise.all(records.map((record) => this.getRecord(collectionId, record.recordId, userIdType)));
  }

  async deleteRecord(collectionId: string, recordId: string): Promise<void> {
    await this.client.begin(async(tx)=>{
    await tx`SELECT pg_advisory_xact_lock(11020261020)`;
    const previous=await tx<StoredRecord[]>`SELECT record_id,fields FROM makit_record
      WHERE collection_id=${collectionId} AND record_id=${recordId} FOR UPDATE`;
    await this.writable(tx,collectionId,previous.map(r=>r.fields));
    const rows = await tx`
      DELETE FROM makit_record WHERE collection_id = ${collectionId} AND record_id = ${recordId}
      RETURNING record_id
    `;
    if (!rows.length) throw new NotFoundException('记录不存在');
    });
  }
}
