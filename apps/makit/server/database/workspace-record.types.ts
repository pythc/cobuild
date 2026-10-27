/** Storage contract kept independent of Feishu transport and SDKs. */
export interface WorkspaceRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

export interface WorkspaceField {
  id: string;
  name: string;
  type: string;
  options: Array<{ id?: string; name?: string }>;
  property?: {
    auto_serial?: { type: string; options?: Array<{ type: string; value: string }> };
  };
}

export interface WorkspaceRecordFilter {
  conjunction: 'and' | 'or';
  conditions: Array<{
    fieldName: string;
    operator: 'is' | 'isNot' | 'contains' | 'doesNotContain' | 'isEmpty' | 'isNotEmpty';
    value?: string[];
  }>;
}

export type WorkspaceUserIdType = 'open_id' | 'user_id';
