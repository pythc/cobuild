import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { RequirementSummary } from '@shared/api.interface';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import { requirementBusinessEvent } from '../../database/schema';
import { FeishuService } from '../requirements/feishu.service';
import { confirmedWorkflowSource, markerOperation, notificationIdentities, workflowEdges, WORKFLOW_SOURCE_VERSION } from './workflow-source.model';

@Injectable()
export class WorkflowSourceService {
  constructor(private readonly database: ServiceRoleDatabaseExecutor, private readonly feishu: FeishuService) {}

  async reconcile(input: { requirementId: string; previousMarker: string; currentMarker: string }) {
    if (!confirmedWorkflowSource() || process.env.WORKFLOW_DELIVERY_OWNER !== 'managed_bot')
      throw new ServiceUnavailableException('统一事件来源未启用');
    if (!input || !/^rec[A-Za-z0-9]{1,80}$/u.test(input.requirementId || '') ||
      [input.previousMarker, input.currentMarker].some((value) => typeof value !== 'string' || (value !== '' && !markerOperation(value))))
      throw new BadRequestException('工作流来源标识无效');
    let edges;
    try {
      edges = await workflowEdges(input.previousMarker, input.currentMarker, async (id) => {
        const [row] = await this.database.run((db) => db.execute<{ before_json: string; after_json: string; fields_json: string }>(sql`
          SELECT before_json,after_json,fields_json FROM ${requirementBusinessEvent}
          WHERE operation_id=${id}::uuid AND requirement_id=${input.requirementId}`));
        if (!row) return null;
        return { operationId: id, fields: JSON.parse(row.fields_json) as string[], before: JSON.parse(row.before_json) as RequirementSummary,
          after: JSON.parse(row.after_json) as RequirementSummary };
      });
    } catch { throw new ConflictException('工作流来源尚未确认，保留扫描基线等待核实'); }
    const snapshots = await notificationIdentities(edges.flatMap((edge) => [edge.before, edge.after]),
      (id) => this.feishu.getOpenIdByEmployeeId(id));
    // Minimal snapshot projection: no capabilities, internal user-ID mappings or secrets.
    const projection = (snapshot: RequirementSummary) => {
      const { personnelUserIds: _ids, capabilities: _capabilities, workflow: _workflow, ...rest } = snapshot;
      return rest;
    };
    return { sourceVersion: WORKFLOW_SOURCE_VERSION, edges: edges.map((edge, index) => ({
      operationId: edge.operationId, fields: edge.fields, before: projection(snapshots[index * 2]), after: projection(snapshots[index * 2 + 1]),
    })) };
  }
}
