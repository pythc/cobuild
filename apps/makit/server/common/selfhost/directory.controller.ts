import { BadRequestException, Body, Controller, NotFoundException, Post } from '@nestjs/common';
import { z } from 'zod';
import { NeedLogin } from './platform';
import { DrizzleDatabaseManager } from './database';
import type { MakitDirectoryUser, MakitUserResolution } from '../../../shared/selfhost-api';
import { MakitOrganizationService } from './organization.service';
import { FeishuService } from '../../modules/requirements/feishu.service';

const searchInput = z.object({ query: z.string().max(200).optional(), offset: z.number().int().min(0).max(100000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(), searchExternalContact: z.boolean().optional(), needFullFields: z.boolean().optional() }).strict();
interface UserRow { id: string; employee_id: string; open_id: string; name: string; avatar_url: string; department_id?: string; department_name?: string }
function user(row: UserRow): MakitDirectoryUser {
  return { userID: row.id || '', employeeID: row.employee_id, larkUserID: row.employee_id, name: { zh_cn: row.name },
    avatar: row.avatar_url, userType: '_employee', department: { departmentID: row.department_id || '', name: { zh_cn: row.department_name || '' } } };
}
@Controller('api/selfhost/users')
@NeedLogin()
export class MakitDirectoryController {
  constructor(private readonly database: DrizzleDatabaseManager, private readonly organization: MakitOrganizationService,
    private readonly feishu: FeishuService) {}
  @Post('search')
  async search(@Body() body: unknown) {
    const parsed = searchInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('查询参数无效');
    await this.organization.refresh();
    const input = parsed.data, sql = this.database.client;
    const predicate = sql`d.active AND strpos(lower(d.name), lower(${input.query || ''})) >= 1`;
    const rows = await sql<UserRow[]>`SELECT u.id, d.*,p.id AS department_id,p.name AS department_name FROM makit_directory d
      LEFT JOIN makit_user u ON d.employee_id = u.employee_id LEFT JOIN makit_department p ON p.id=d.department_ids->>0
      WHERE ${predicate} ORDER BY d.name, u.id LIMIT ${input.pageSize || 20} OFFSET ${input.offset || 0}`;
    const [count] = await sql`SELECT count(*)::int AS total FROM makit_directory d WHERE ${predicate}`;
    return { data: { userList: rows.map(user), total: count.total }, status_code: '0' };
  }
  @Post('batch')
  async batch(@Body() body: unknown) {
    const parsed = z.object({ userIds: z.array(z.string().min(1).max(128)).max(100) }).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('成员查询无效');
    const ids = parsed.data.userIds, sql = this.database.client;
    if (!ids.length) return { data: { userInfoMap: {} } };
    const rows = await sql<UserRow[]>`SELECT u.id, d.* FROM makit_directory d LEFT JOIN makit_user u ON d.employee_id = u.employee_id
      WHERE u.id IN ${sql(ids)} OR d.employee_id IN ${sql(ids)} OR d.open_id IN ${sql(ids)}`;
    const map = Object.fromEntries(ids.flatMap((id) => {
      const row = rows.find((row) => [row.id, row.employee_id, row.open_id].includes(id));
      return row ? [[id, { ...user(row), avatar: { image: { large: row.avatar_url } } }]] : [];
    }));
    return { data: { userInfoMap: map } };
  }
  @Post('profile')
  async profile(@Body() body: unknown) {
    const parsed = z.object({ userId: z.string().min(1).max(128), accountType: z.enum(['apaas', 'lark']) }).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('成员查询无效');
    const id = parsed.data.userId;
    const [row] = await this.database.client<UserRow[]>`SELECT u.id, d.* FROM makit_directory d LEFT JOIN makit_user u ON d.employee_id = u.employee_id
      WHERE u.id = ${id} OR d.employee_id = ${id} OR d.open_id = ${id}`;
    if (!row) throw new NotFoundException('组织成员不存在');
    return { useLarkCard: false, userProfileInfo: { name: row.name, avatar: row.avatar_url, userStatus: 1, userType: '_employee' } };
  }
  @Post('resolve')
  async resolve(@Body() body: unknown): Promise<MakitUserResolution> {
    const parsed = z.object({ larkUserID: z.string().min(1).max(128) }).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('成员查询无效');
    const id = parsed.data.larkUserID;
    const [member] = await this.database.client<{union_id:string}[]>`SELECT union_id FROM makit_directory
      WHERE active AND (employee_id=${id} OR open_id=${id})`;
    if (member?.union_id) await this.feishu.getUserByUnionId(member.union_id);
    const [row] = await this.database.client<{ id: string }[]>`SELECT u.id FROM makit_user u JOIN makit_directory d ON d.employee_id = u.employee_id
      WHERE u.active AND d.active AND (d.employee_id = ${id} OR d.open_id = ${id})`;
    if (!row) throw new NotFoundException('此成员尚未启用 Makit');
    return { data: { userInfo: { userID: row.id } } };
  }
}
