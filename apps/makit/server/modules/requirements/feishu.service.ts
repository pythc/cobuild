import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import axios, { type AxiosInstance, isAxiosError } from 'axios';
import { WorkspaceRecordStore } from '../../database/workspace-record.store';
import { MakitIdentityRepository } from '../../common/selfhost/identity.repository';
import { notificationPolicyDecision } from './notification-policy';
import { OperationsTelemetryService } from '../operations/operations-telemetry.service';

interface FeishuEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

export interface BaseRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

export interface BaseField {
  id: string;
  name: string;
  type: string;
  options: Array<{ id?: string; name?: string }>;
}

export interface BaseRecordSearchCondition {
  fieldName: string;
  operator:
    | 'is'
    | 'isNot'
    | 'contains'
    | 'doesNotContain'
    | 'isEmpty'
    | 'isNotEmpty';
  value?: string[];
}

export interface BaseRecordSearchFilter {
  conjunction: 'and' | 'or';
  conditions: BaseRecordSearchCondition[];
}

export interface BaseRecordPage {
  items: BaseRecord[];
  hasMore: boolean;
}

export interface FeishuDocumentContent {
  token: string;
  title: string;
  content: string;
}

interface BaseFieldEnvelope {
  field_id?: string;
  field_name?: string;
  type?: number | string;
  property?: {
    options?: Array<{ id?: string; name?: string }>;
  };
}

type UserIdType = 'open_id' | 'user_id';

export interface FeishuMessageReceipt {
  messageId: string;
  providerRequestId: string;
}

export class FeishuRequestError extends ServiceUnavailableException {
  constructor(message: string, readonly remoteRejected: boolean, readonly errorCode: string) { super(message); }
}

export class FeishuMessageDeliveryError extends Error {
  constructor(readonly outcome: 'rejected' | 'unknown', readonly errorCode: string) {
    super(outcome === 'unknown' ? '飞书投递结果待核实' : '飞书未接受此消息');
  }
}

@Injectable()
export class FeishuService {
  constructor(
    @Optional() private readonly telemetry?: OperationsTelemetryService,
    @Optional() private readonly records?: WorkspaceRecordStore,
    @Optional() private readonly identities?: MakitIdentityRepository,
  ) {}
  private readonly logger: Logger = new Logger(FeishuService.name);
  private readonly apiBase: string = 'https://open.feishu.cn/open-apis';
  private readonly client: AxiosInstance = axios.create({
    timeout: 15_000,
    maxRedirects: 3,
  });
  private token: string = '';
  private tokenExpiresAt: number = 0;
  private tokenRequest: Promise<string> | null = null;

  private requiredEnv(name: string): string {
    const value: string = process.env[name]?.trim() || '';
    if (!value) {
      throw new ServiceUnavailableException(`服务缺少环境变量 ${name}`);
    }
    return value;
  }

  private async tenantToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }
    if (this.tokenRequest) return this.tokenRequest;
    const request: Promise<string> = (async (): Promise<string> => {
      try {
        const response = await this.client.post<{
          code: number;
          msg: string;
          tenant_access_token: string;
          expire: number;
        }>(`${this.apiBase}/auth/v3/tenant_access_token/internal/`, {
          app_id: this.requiredEnv('FEISHU_APP_ID'),
          app_secret: this.requiredEnv('FEISHU_APP_SECRET'),
        });
        if (response.data.code !== 0 || !response.data.tenant_access_token) {
          throw new Error(response.data.msg || '未返回 tenant_access_token');
        }
        this.token = response.data.tenant_access_token;
        this.tokenExpiresAt =
          Date.now() + Math.max(60, response.data.expire - 300) * 1000;
        return this.token;
      } catch (error) {
        this.logger.error('获取飞书服务身份失败（响应内容已隐藏）');
        throw new ServiceUnavailableException('暂时无法连接飞书开放平台');
      } finally {
        this.tokenRequest = null;
      }
    })();
    this.tokenRequest = request;
    return request;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string,
    options: {params?: Record<string, unknown>; data?: unknown; retryableRead?: boolean} = {},
  ): Promise<T> {
    if (process.env.MAKIT_STORAGE === 'postgres' && path.startsWith('/bitable/')) {
      throw new ServiceUnavailableException('已停用飞书表运行时访问');
    }
    const kind = path.includes('/records') ? 'records' : path.includes('/fields') ? 'fields'
      : path.includes('/messages') ? 'messages' : path.includes('/docx/') || path.includes('/wiki/') ? 'documents'
      : path.includes('/contact/') ? 'identity' : 'other';
    const work = () => this.requestImpl<T>(method, path, options);
    return this.telemetry ? this.telemetry.measure('feishu', `${method.toLowerCase()}_${kind}`, work) : work();
  }

  private async requestImpl<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: {
      params?: Record<string, unknown>;
      data?: unknown;
      retryableRead?: boolean;
    } = {},
  ): Promise<T> {
    if (process.env.MAKIT_EXTERNAL_WRITES_ENABLED === 'false' && method !== 'GET' && !options.retryableRead) {
      throw new ServiceUnavailableException('当前迁移演练未启用外部写入');
    }
    const token: string = await this.tenantToken();
    const isRead: boolean = method === 'GET' || options.retryableRead === true;
    const maxAttempts: number = isRead ? 3 : 1;
    let lastError: unknown = null;
    for (let attempt: number = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.client.request<FeishuEnvelope<T>>({
          method,
          url: `${this.apiBase}${path}`,
          params: options.params,
          data: options.data,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
        });
        const envelope: FeishuEnvelope<T> = response.data;
        if (typeof envelope.code === 'number' && envelope.code !== 0) {
          throw new FeishuRequestError(
            `${envelope.code}: ${envelope.msg || '飞书接口失败'}`,
            true,
            `feishu_rejected_${envelope.code}`,
          );
        }
        return (envelope.data ?? envelope) as T;
      } catch (error) {
        lastError = error;
        const status: number | undefined = isAxiosError(error)
          ? error.response?.status
          : undefined;
        const apiCode: number | undefined = error instanceof FeishuRequestError ? Number(error.errorCode.split('_').at(-1)) : isAxiosError<
          FeishuEnvelope<unknown>
        >(error)
          ? error.response?.data?.code
          : undefined;
        const retryable: boolean =
          isRead &&
          (apiCode === 1254607 ||
            apiCode === 99991400 ||
            status === 429 ||
            (status != null && status >= 500) ||
            (isAxiosError(error) &&
              ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(
                error.code || '',
              )));
        if (retryable && attempt < maxAttempts) {
          const delay: number = attempt === 1 ? 400 : 1_000;
          this.logger.warn(
            `${method} ${path} 暂时不可用，${delay}ms 后执行第 ${attempt + 1} 次尝试`,
          );
          await new Promise<void>((resolve): void => {
            setTimeout(resolve, delay);
          });
          continue;
        }
        break;
      }
    }
    this.logger.error(`飞书 ${method} 请求失败（响应内容已隐藏）`);
    const apiMessage: string =
      isAxiosError<FeishuEnvelope<unknown>>(lastError) &&
      lastError.response?.data?.msg
        ? lastError.response.data.msg
        : lastError instanceof Error
          ? lastError.message
          : '飞书接口调用失败';
    if (lastError instanceof FeishuRequestError) throw lastError;
    const httpStatus: number | undefined = isAxiosError(lastError) ? lastError.response?.status : undefined;
    const rejected: boolean = httpStatus != null && httpStatus >= 400 && httpStatus < 500;
    throw new FeishuRequestError(apiMessage, rejected, rejected ? `feishu_rejected_${httpStatus}` : 'feishu_write_result_unknown');
  }

  private baseToken(): string {
    return this.requiredEnv('FEISHU_BASE_TOKEN');
  }

  async documentContent(documentUrl: string): Promise<FeishuDocumentContent> {
    let url: URL;
    try {
      url = new URL(documentUrl.trim());
    } catch {
      throw new ServiceUnavailableException('飞书文档链接格式不正确');
    }
    const hostname: string = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      !(
        hostname.endsWith('.feishu.cn') ||
        hostname.endsWith('.larksuite.com') ||
        hostname.endsWith('.doubao.com')
      )
    ) {
      throw new ServiceUnavailableException('仅支持飞书云文档链接');
    }
    const segments: string[] = url.pathname.split('/').filter(Boolean);
    let token: string = '';
    const docxIndex: number = segments.indexOf('docx');
    const wikiIndex: number = segments.indexOf('wiki');
    if (docxIndex >= 0) token = segments[docxIndex + 1] || '';
    if (!token && wikiIndex >= 0) {
      const wikiToken: string = segments[wikiIndex + 1] || '';
      if (!wikiToken) {
        throw new ServiceUnavailableException('飞书知识库链接缺少文档标识');
      }
      const node = await this.request<{
        node?: { obj_type?: string; obj_token?: string; title?: string };
      }>('GET', '/wiki/v2/spaces/get_node', {
        params: { token: wikiToken, obj_type: 'wiki' },
        retryableRead: true,
      });
      if (node.node?.obj_type !== 'docx' || !node.node.obj_token) {
        throw new ServiceUnavailableException('该知识库节点不是新版飞书文档');
      }
      token = node.node.obj_token;
    }
    if (!token) {
      throw new ServiceUnavailableException('仅支持新版飞书文档或知识库链接');
    }
    const [raw, metadata] = await Promise.all([
      this.request<{ content?: string }>(
        'GET',
        `/docx/v1/documents/${encodeURIComponent(token)}/raw_content`,
        { retryableRead: true },
      ),
      this.request<{ document?: { title?: string } }>(
        'GET',
        `/docx/v1/documents/${encodeURIComponent(token)}`,
        { retryableRead: true },
      ),
    ]);
    const content: string = raw.content?.trim() || '';
    if (!content) {
      throw new ServiceUnavailableException('飞书文档没有可评审的正文内容');
    }
    return {
      token,
      title: metadata.document?.title?.trim() || '飞书文档',
      content,
    };
  }

  async listRecords(tableId: string, fieldNames?: string[]): Promise<BaseRecord[]> {
    if (this.records) return this.records.listRecords(tableId, fieldNames);
    const records: BaseRecord[] = [];
    let pageToken: string = '';
    const seenTokens = new Set<string>();
    do {
      const data = await this.request<{
        items?: BaseRecord[];
        has_more?: boolean;
        page_token?: string;
      }>(
        fieldNames ? 'POST' : 'GET',
        `/bitable/v1/apps/${encodeURIComponent(this.baseToken())}/tables/${encodeURIComponent(tableId)}/records${fieldNames ? '/search' : ''}`,
        {
          params: {
            page_size: 500,
            page_token: pageToken || undefined,
            user_id_type: 'open_id',
          },
          ...(fieldNames ? { data: { field_names: fieldNames }, retryableRead: true } : {}),
        },
      );
      records.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token || '' : '';
      if (data.has_more && (!pageToken || seenTokens.has(pageToken))) {
        throw new ServiceUnavailableException('需求源数据分页未完整返回，请稍后重试');
      }
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return records;
  }

  async searchRecords(
    tableId: string,
    filter: BaseRecordSearchFilter,
    userIdType: UserIdType = 'open_id',
  ): Promise<BaseRecord[]> {
    if (this.records) return this.records.searchRecords(tableId, filter, userIdType);
    const records: BaseRecord[] = [];
    let pageToken: string = '';
    do {
      const data = await this.request<{
        items?: BaseRecord[];
        has_more?: boolean;
        page_token?: string;
      }>(
        'POST',
        `/bitable/v1/apps/${encodeURIComponent(this.baseToken())}/tables/${encodeURIComponent(tableId)}/records/search`,
        {
          params: {
            page_size: 500,
            page_token: pageToken || undefined,
            user_id_type: userIdType,
          },
          data: {
            filter: {
              conjunction: filter.conjunction,
              conditions: filter.conditions.map(
                (condition: BaseRecordSearchCondition) => ({
                  field_name: condition.fieldName,
                  operator: condition.operator,
                  ...(condition.value ? { value: condition.value } : {}),
                }),
              ),
            },
          },
          retryableRead: true,
        },
      );
      records.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token || '' : '';
    } while (pageToken);
    return records;
  }

  /** A bounded read for audit screens; never follows the next-page token. */
  async searchRecordPage(
    tableId: string,
    filter: BaseRecordSearchFilter,
    fieldNames: string[],
    pageSize: number = 500,
  ): Promise<BaseRecordPage> {
    if (this.records) return this.records.searchRecordPage(tableId, filter, fieldNames, pageSize);
    const data = await this.request<{
      items?: BaseRecord[];
      has_more?: boolean;
    }>(
      'POST',
      `/bitable/v1/apps/${encodeURIComponent(this.baseToken())}/tables/${encodeURIComponent(tableId)}/records/search`,
      {
        params: {
          page_size: Math.min(500, Math.max(1, Math.trunc(pageSize) || 500)),
          user_id_type: 'user_id',
        },
        data: {
          field_names: fieldNames,
          sort: [{ field_name: '创建时间', desc: true }],
          filter: {
            conjunction: filter.conjunction,
            conditions: filter.conditions.map(
              (condition: BaseRecordSearchCondition) => ({
                field_name: condition.fieldName,
                operator: condition.operator,
                ...(condition.value ? { value: condition.value } : {}),
              }),
            ),
          },
        },
        retryableRead: true,
      },
    );
    return { items: data.items || [], hasMore: data.has_more === true };
  }

  async getRecord(
    tableId: string,
    recordId: string,
    userIdType: UserIdType = 'open_id',
  ): Promise<BaseRecord> {
    if (this.records) return this.records.getRecord(tableId, recordId, userIdType);
    const data = await this.request<{ record: BaseRecord }>(
      'GET',
      `/bitable/v1/apps/${encodeURIComponent(this.baseToken())}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
      { params: { user_id_type: userIdType } },
    );
    return data.record;
  }

  async listFields(tableId: string): Promise<BaseField[]> {
    if (this.records) return this.records.listFields(tableId);
    const fields: BaseField[] = [];
    let pageToken: string = '';
    do {
      const data = await this.request<{
        items?: BaseFieldEnvelope[];
        has_more?: boolean;
        page_token?: string;
      }>(
        'GET',
        `/bitable/v1/apps/${encodeURIComponent(this.baseToken())}/tables/${encodeURIComponent(tableId)}/fields`,
        {
          params: {
            page_size: 200,
            page_token: pageToken || undefined,
          },
        },
      );
      fields.push(
        ...(data.items || []).map(
          (field: BaseFieldEnvelope): BaseField => ({
            id: field.field_id || '',
            name: field.field_name || '',
            type: String(field.type ?? ''),
            options: field.property?.options || [],
          }),
        ),
      );
      pageToken = data.has_more ? data.page_token || '' : '';
    } while (pageToken);
    return fields;
  }

  async createRecord(
    tableId: string,
    fields: Record<string, unknown>,
    userIdType: UserIdType = 'open_id',
  ): Promise<BaseRecord> {
    if (this.records) return this.records.createRecord(tableId, fields, userIdType);
    const data = await this.request<{ record: BaseRecord }>(
      'POST',
      `/bitable/v1/apps/${encodeURIComponent(this.baseToken())}/tables/${encodeURIComponent(tableId)}/records`,
      {
        params: { user_id_type: userIdType },
        data: { fields },
      },
    );
    return data.record;
  }

  async updateRecord(
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
    userIdType: UserIdType = 'open_id',
  ): Promise<BaseRecord> {
    if (this.records) return this.records.updateRecord(tableId, recordId, fields, userIdType);
    const data = await this.request<{ record: BaseRecord }>(
      'PUT',
      `/bitable/v1/apps/${encodeURIComponent(this.baseToken())}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
      {
        params: { user_id_type: userIdType },
        data: { fields },
      },
    );
    return data.record;
  }

  async batchUpdateRecords(
    tableId: string,
    records: Array<{ recordId: string; fields: Record<string, unknown> }>,
    userIdType: UserIdType = 'open_id',
  ): Promise<BaseRecord[]> {
    if (this.records) return this.records.batchUpdateRecords(tableId, records, userIdType);
    if (!records.length) return [];
    const data = await this.request<{ records?: BaseRecord[] }>(
      'POST',
      `/bitable/v1/apps/${encodeURIComponent(this.baseToken())}/tables/${encodeURIComponent(tableId)}/records/batch_update`,
      {
        params: { user_id_type: userIdType },
        data: {
          records: records.map(
            (
              record,
            ): { record_id: string; fields: Record<string, unknown> } => ({
              record_id: record.recordId,
              fields: record.fields,
            }),
          ),
        },
      },
    );
    return data.records || [];
  }

  async deleteRecord(tableId: string, recordId: string): Promise<void> {
    if (this.records) return this.records.deleteRecord(tableId, recordId);
    await this.request(
      'DELETE',
      `/bitable/v1/apps/${encodeURIComponent(this.baseToken())}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
    );
  }

  private avatarCache = new Map<string,{value:string;expires:number}>();
  private avatarRequests = new Map<string,Promise<string>>();
  async getAvatarByOpenId(openId: string): Promise<string> {
    if (!/^ou_[A-Za-z0-9_-]{5,128}$/.test(openId)) throw new ServiceUnavailableException('成员标识无效');
    const cached = this.avatarCache.get(openId);
    if (cached && cached.expires > Date.now()) return cached.value;
    const pending = this.avatarRequests.get(openId); if (pending) return pending;
    const work = async (): Promise<string> => {
      const data = await this.request<{user?:{avatar?:{avatar_240?:string;avatar_origin?:string}}}>(
        'GET', `/contact/v3/users/${encodeURIComponent(openId)}`, {params:{user_id_type:'open_id'}});
      let value = '';
      try { const url = new URL(data.user?.avatar?.avatar_240 || data.user?.avatar?.avatar_origin || '');
        if (url.protocol === 'https:' && !url.username && !url.password) value = url.href;
      } catch { /* No avatar is a supported provider response. */ }
      if (this.avatarCache.size > 2000) this.avatarCache.clear();
      this.avatarCache.set(openId,{value,expires:Date.now()+300000});return value;
    };
    const request = work().finally(()=>this.avatarRequests.delete(openId));
    this.avatarRequests.set(openId,request);return request;
  }

  async projectSubject(employeeId: string): Promise<string> {
    const tenant = process.env.LAB_IDENTITY_TENANT_KEY || '';
    if (!employeeId || !tenant) throw new ServiceUnavailableException('项目身份尚未配置');
    const data = await this.request<{user?: {union_id?: string; user_id?: string; status?: {is_resigned?: boolean; is_frozen?: boolean; is_exited?: boolean; is_activated?: boolean}}}>(
      'GET', `/contact/v3/users/${encodeURIComponent(employeeId)}`, {params: {user_id_type:'user_id'}});
    const user = data.user;
    if (user?.user_id !== employeeId || !/^on_[A-Za-z0-9_-]{10,100}$/.test(user.union_id || '')
      || !user?.status || user.status.is_resigned || user.status.is_frozen || user.status.is_exited || user.status.is_activated !== true)
      throw new ServiceUnavailableException('无法核对项目操作身份');
    return tenant + ':' + user.union_id;
  }

  async getUserByUnionId(unionId:string):Promise<{employeeId:string;openId:string;name:string}>{
    const data=await this.request<{user?:{union_id?:string;user_id?:string;open_id?:string;name?:string;department_ids?:string[];avatar?:{avatar_240?:string};status?:{is_resigned?:boolean;is_frozen?:boolean;is_exited?:boolean;is_activated?:boolean}}}>('GET',`/contact/v3/users/${encodeURIComponent(unionId)}`,{params:{user_id_type:'union_id',department_id_type:'open_department_id'}});
    const u=data.user;
    // Explicit offboarding/freezing is a denial, never a provider outage that
    // could qualify for the native session's short read-only grace period.
    if (u?.status?.is_resigned || u?.status?.is_frozen || u?.status?.is_exited || u?.status?.is_activated===false)
      throw new UnauthorizedException('此组织成员已停用');
    if(!u||u.union_id!==unionId||!u.user_id||!u.open_id||!u.name)throw new UnauthorizedException('无法确认组织成员身份');
    if (this.identities) {
      if (u.status?.is_activated !== true) throw new ServiceUnavailableException('无法确认组织成员状态');
      const policy = await this.identities.policy(), chats: string[] = [];
      for (const chatId of policy.chats) if ((await this.cachedChatMembers(chatId)).includes(u.open_id)) chats.push(chatId);
      await this.identities.register({employeeId:u.user_id,openId:u.open_id,unionId,name:u.name,
        avatar:u.avatar?.avatar_240 || '',departments:u.department_ids || []},chats,policy);
      if (this.permissionFreshness.size>1000) this.permissionFreshness.clear();
      this.permissionFreshness.set(u.user_id,Date.now()+30000);
    }
    return {employeeId:u.user_id,openId:u.open_id,name:u.name};
  }

  private readonly permissionFreshness = new Map<string,number>();
  async refreshMakitPermissions(employeeId:string):Promise<void> {
    if (!this.identities || (this.permissionFreshness.get(employeeId) || 0)>Date.now()) return;
    await this.getUserByUnionId(await this.identities.unionId(employeeId));
  }

  private readonly groupMembers = new Map<string,{ids:string[];expires:number}>();
  private async cachedChatMembers(chatId: string) {
    const cached = this.groupMembers.get(chatId);
    if (cached && cached.expires > Date.now()) return cached.ids;
    const ids = await this.listChatMemberIds(chatId);
    this.groupMembers.set(chatId,{ids,expires:Date.now()+60000});
    return ids;
  }

  async organizationSnapshot() {
    type Department = {open_department_id:string;parent_department_id:string;name:string};
    type Member = {user_id:string;open_id:string;union_id:string;name:string;department_ids?:string[];
      avatar?:{avatar_240?:string};status?:{is_activated?:boolean;is_resigned?:boolean;is_frozen?:boolean;is_exited?:boolean}};
    const departments: Department[] = [], members = new Map<string,Member>();
    let token = '';
    const seen = new Set<string>();
    do {
      const page = await this.request<{items?:Department[];has_more?:boolean;page_token?:string}>('GET','/contact/v3/departments/0/children',
        {params:{department_id_type:'open_department_id',fetch_child:true,page_size:50,page_token:token || undefined}});
      departments.push(...page.items || []);
      if (page.has_more && (!page.page_token || seen.has(page.page_token))) throw new ServiceUnavailableException('通讯录分页不完整');
      token = page.has_more ? page.page_token! : ''; seen.add(token);
    } while(token);
    for (const departmentId of ['0',...departments.map((department) => department.open_department_id)]) {
      token=''; seen.clear();
      do {
        const page = await this.request<{items?:Member[];has_more?:boolean;page_token?:string}>('GET','/contact/v3/users/find_by_department',
          {params:{department_id:departmentId,department_id_type:'open_department_id',user_id_type:'user_id',page_size:50,page_token:token || undefined}});
        for (const member of page.items || []) {
          if (!member.user_id || !member.open_id || !member.union_id || !member.status) throw new ServiceUnavailableException('通讯录身份字段不完整');
          members.set(member.user_id,member);
        }
        if (page.has_more && (!page.page_token || seen.has(page.page_token))) throw new ServiceUnavailableException('通讯录分页不完整');
        token=page.has_more ? page.page_token! : ''; seen.add(token);
      } while(token);
    }
    return {departments,members:[...members.values()]};
  }

  async visibleChats() {
    const items: Array<{chat_id:string;name:string;avatar?:string;external?:boolean}> = [];
    const seen = new Set<string>(); let token='';
    do {
      const page = await this.request<{items?:typeof items;has_more?:boolean;page_token?:string}>('GET','/im/v1/chats',
        {params:{page_size:100,page_token:token || undefined}});
      items.push(...page.items || []);
      if (page.has_more && (!page.page_token || seen.has(page.page_token))) throw new ServiceUnavailableException('群聊分页不完整');
      token=page.has_more ? page.page_token! : ''; seen.add(token);
    } while(token);
    return items;
  }

  async getOpenIdByEmployeeId(employeeId: string): Promise<string> {
    if (!employeeId) return '';
    if (this.records) {
      const openId = await this.records.openIdByEmployeeId(employeeId);
      if (openId) return openId;
    }
    const data = await this.request<{
      user?: { open_id?: string };
    }>('GET', `/contact/v3/users/${encodeURIComponent(employeeId)}`, {
      params: { user_id_type: 'user_id' },
    });
    return data.user?.open_id || '';
  }

  async getUserByEmployeeId(
    employeeId: string,
  ): Promise<{ employeeId: string; openId: string; name: string }> {
    if (!employeeId) {
      throw new ServiceUnavailableException('飞书用户 ID 不能为空');
    }
    const data = await this.request<{
      user?: { user_id?: string; open_id?: string; name?: string };
    }>('GET', `/contact/v3/users/${encodeURIComponent(employeeId)}`, {
      params: { user_id_type: 'user_id' },
    });
    if (!data.user?.user_id) {
      throw new ServiceUnavailableException('未找到对应的飞书用户');
    }
    return {
      employeeId: data.user.user_id,
      openId: data.user.open_id || '',
      name: data.user.name || employeeId,
    };
  }

  async getUserByOpenId(
    openId: string,
  ): Promise<{ employeeId: string; openId: string; name: string }> {
    if (!openId) {
      throw new ServiceUnavailableException('未配置 MCP 操作人');
    }
    const data = await this.request<{
      user?: { user_id?: string; open_id?: string; name?: string };
    }>('GET', `/contact/v3/users/${encodeURIComponent(openId)}`, {
      params: { user_id_type: 'open_id' },
    });
    return {
      employeeId: data.user?.user_id || '',
      openId: data.user?.open_id || openId,
      name: data.user?.name || '周灿宇',
    };
  }

  async createChat(input: {
    uuid: string;
    name: string;
    description: string;
    ownerId: string;
    memberIds: string[];
  }): Promise<string> {
    const data = await this.request<{ chat_id?: string }>(
      'POST',
      '/im/v1/chats',
      {
        params: {
          user_id_type: 'open_id',
          set_bot_manager: true,
          uuid: input.uuid,
        },
        data: {
          name: input.name,
          description: input.description,
          owner_id: input.ownerId,
          user_id_list: input.memberIds,
          chat_type: 'private',
        },
      },
    );
    if (!data.chat_id) {
      throw new ServiceUnavailableException('飞书创建群聊后未返回 chat_id');
    }
    return data.chat_id;
  }

  async createPermanentChatLink(chatId: string): Promise<string> {
    const data = await this.request<{ share_link?: string }>(
      'POST',
      `/im/v1/chats/${encodeURIComponent(chatId)}/link`,
      { data: { validity_period: 'permanently' } },
    );
    return data.share_link || '';
  }

  async listChatMemberIds(chatId: string): Promise<string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    let pageToken: string = '';
    do {
      const data = await this.request<{
        items?: Array<{ member_id?: string; id?: string }>;
        has_more?: boolean;
        page_token?: string;
      }>('GET', `/im/v1/chats/${encodeURIComponent(chatId)}/members`, {
        params: {
          member_id_type: 'open_id',
          page_size: 100,
          page_token: pageToken || undefined,
        },
      });
      ids.push(
        ...(data.items || [])
          .map(
            (item: { member_id?: string; id?: string }): string =>
              item.member_id || item.id || '',
          )
          .filter(Boolean),
      );
      if (data.has_more && (!data.page_token || seen.has(data.page_token))) {
        throw new ServiceUnavailableException('无法完整核对群成员');
      }
      pageToken = data.has_more ? data.page_token! : '';
      seen.add(pageToken);
    } while (pageToken);
    return ids;
  }

  async addChatMembers(chatId: string, memberIds: string[]): Promise<void> {
    if (!memberIds.length) return;
    await this.request(
      'POST',
      `/im/v1/chats/${encodeURIComponent(chatId)}/members`,
      {
        params: {
          member_id_type: 'open_id',
          succeed_type: 1,
        },
        data: { id_list: memberIds },
      },
    );
  }

  async sendGroupPost(
    chatId: string,
    title: string,
    requirementTitle: string,
    requirementUrl: string,
    people: Array<{ id: string; name: string }>,
    uuid: string,
    ticket = false,
  ): Promise<FeishuMessageReceipt | null> {
    const policy = notificationPolicyDecision(chatId);
    if (!policy.allowed) {
      this.logger.warn(
        `群消息已被通知门禁拦截，mode=${policy.mode}，reason=${policy.reason}`,
      );
      return null;
    }
    const mentionNodes: Array<{
      tag: 'at';
      user_id: string;
      user_name: string;
    }> = people.map(
      (person: {
        id: string;
        name: string;
      }): { tag: 'at'; user_id: string; user_name: string } => ({
        tag: 'at',
        user_id: person.id,
        user_name: person.name,
      }),
    );
    return this.sendMessageWithReceipt(chatId, 'chat_id', 'post', {
          zh_cn: {
            title,
            content: [
              [
                {
                  tag: 'a',
                  text: requirementTitle,
                  href: requirementUrl,
                },
              ],
              mentionNodes,
              [
                {
                  tag: 'text',
                  text: ticket ? '请在本群讨论问题并同步处理进展，处理结果请更新到工单。' : '请相关人员在本群同步需求决策、进展和阻塞事项。',
                },
              ],
            ],
          },
        }, uuid);
  }

  async sendDirectPost(
    employeeId: string,
    title: string,
    lines: string[],
    linkText: string,
    link: string,
    uuid: string,
  ): Promise<FeishuMessageReceipt> {
    if (!employeeId) {
      throw new ServiceUnavailableException('通知对象未关联飞书账号');
    }
    return this.sendMessageWithReceipt(employeeId, 'user_id', 'post', {
          zh_cn: {
            title,
            content: [
              ...lines.map((line: string) => [
                {
                  tag: 'text',
                  text: line,
                },
              ]),
              [
                {
                  tag: 'a',
                  text: linkText,
                  href: link,
                },
              ],
            ],
          },
        }, uuid);
  }

  async sendMessageWithReceipt(
    targetId: string,
    receiveIdType: 'user_id' | 'open_id' | 'chat_id',
    messageType: 'post' | 'interactive',
    content: Record<string, unknown>,
    uuid: string,
  ): Promise<FeishuMessageReceipt> {
    if (process.env.MAKIT_EXTERNAL_WRITES_ENABLED === 'false') throw new FeishuMessageDeliveryError('rejected','rehearsal_external_write_disabled');
    let token: string;
    try { token = await this.tenantToken(); } catch {
      // No send request has happened; retrying this preflight failure is safe.
      throw new FeishuMessageDeliveryError('rejected', 'feishu_rejected_503');
    }
    try {
      const response = await this.client.request<FeishuEnvelope<{ message_id?: string }>>({
        method: 'POST', url: `${this.apiBase}/im/v1/messages`,
        params: { receive_id_type: receiveIdType },
        // uuid is a request BODY field. Its upstream deduplication lasts one hour.
        data: { receive_id: targetId, msg_type: messageType, content: JSON.stringify(content), uuid },
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      });
      if (typeof response.data.code === 'number' && response.data.code !== 0) {
        throw new FeishuMessageDeliveryError('rejected', `feishu_rejected_${response.data.code}`);
      }
      const messageId: string = response.data.data?.message_id || '';
      if (!messageId.startsWith('om_')) throw new FeishuMessageDeliveryError('unknown', 'missing_message_receipt');
      return { messageId, providerRequestId: String(response.headers?.['x-tt-logid'] || response.headers?.['x-request-id'] || '').slice(0,128) };
    } catch (error) {
      if (error instanceof FeishuMessageDeliveryError) throw error;
      const status: number | undefined = isAxiosError(error) ? error.response?.status : undefined;
      if (status && [400,401,403,404,413,422,429].includes(status)) throw new FeishuMessageDeliveryError('rejected', `feishu_rejected_${status}`);
      // Network errors and HTTP 5xx can arrive after the upstream accepted the message.
      throw new FeishuMessageDeliveryError('unknown', 'message_transport_ambiguous');
    }
  }
}
