import { Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { ForceRoleDTO } from '../../../shared/api.interface';
import { DrizzleDatabaseManager } from './database';
import { RequestContextService } from './context';
export * from './database';
export { RequestContextService } from './context';

export const NeedLogin = () => SetMetadata('makit:login', true);
export const Public = () => SetMetadata('makit:public', true);
export interface MemberMutationData { userList?: Array<{ userID: string }> }

@Injectable()
export class AuthNPaasService {
  constructor(private readonly database: DrizzleDatabaseManager, private readonly context: RequestContextService) {}
  async getBatchLarkUserIds(ids: string[]): Promise<(string | null)[]> {
    if (!ids.length) return [];
    const rows = await this.database.client<{ id: string; employee_id: string }[]>`
      SELECT id, employee_id FROM makit_user WHERE id IN ${this.database.client(ids)} AND active
    `;
    const map = new Map(rows.map((row) => [row.id, row.employee_id]));
    return ids.map((id) => map.get(id) || null);
  }
  async getBatchMiaodaUserIds(ids: string[]): Promise<(string | null)[]> {
    if (!ids.length) return [];
    const rows = await this.database.client<{ id: string; employee_id: string }[]>`
      SELECT id, employee_id FROM makit_user WHERE employee_id IN ${this.database.client(ids)} AND active
    `;
    const map = new Map(rows.map((row) => [row.employee_id, row.id]));
    return ids.map((id) => map.get(id) || null);
  }
  async getCurrentUserLarkUserId(): Promise<string> {
    return (await this.getBatchLarkUserIds([this.context.current?.userId || '']))[0] || '';
  }
}

@Injectable()
export class PlatformHttpClientService {
  constructor(private readonly database: DrizzleDatabaseManager) {}
  readonly instance = {
    post: async (path: string, body: { userID: string }): Promise<{ ok: boolean; text: () => Promise<string> }> => {
      const expected = `/app/${process.env.REQUIREMENT_PLATFORM_APP_ID}/inner/api/v1/permissions/roles`;
      if (path !== expected) throw new Error('Unsupported legacy platform operation');
      const users = await this.database.client`
        SELECT 1 FROM makit_user u JOIN makit_directory d ON d.employee_id = u.employee_id
        WHERE u.id = ${body.userID} AND u.active AND d.active
      `;
      if (!users.length) return { ok: false, text: async () => '' };
      const rows = await this.database.client<{ role_id: string }[]>`
        SELECT r.role_id FROM makit_user_role r JOIN makit_user u ON u.id = r.user_id
        WHERE u.id = ${body.userID} AND u.active
      `;
      return { ok: true, text: async () => JSON.stringify({ data: { roleList: rows.map((row) => row.role_id) } }) };
    },
  };
}

@Injectable()
export class AuthorizationSDK {
  constructor(private readonly database: DrizzleDatabaseManager, private readonly context: RequestContextService) {}
  private async manager(): Promise<void> {
    const rows = await this.database.client`
      SELECT 1 FROM makit_user_role r JOIN makit_user u ON u.id = r.user_id
      WHERE u.id = ${this.context.current?.userId || ''} AND u.active AND r.role_id = 'operations_super_admin'
    `;
    if (!rows.length) throw new UnauthorizedException('仅高级管理员可管理运行管理员');
  }
  readonly roles = {
    list: async (_input: { needMember: boolean }): Promise<ForceRoleDTO[]> => {
      await this.manager();
      return Promise.all(['operations_super_admin', 'operations_viewer'].map(async (role) => {
        const members = await this.database.client<{ id: string; name: string }[]>`
          SELECT u.id, d.name FROM makit_user_role r JOIN makit_user u ON u.id = r.user_id
          JOIN makit_directory d ON d.employee_id = u.employee_id WHERE r.role_id = ${role} AND u.active
        `;
        return { bizID: role, name: role === 'operations_super_admin' ? '高级运行管理员' : '运行管理员',
          roleMembers: { userList: members.map((member) => ({ userID: member.id, name: { zh_cn: member.name } })) } };
      }));
    },
  };
  private async change(role: string, input: { members: MemberMutationData }, remove: boolean): Promise<void> {
    await this.manager();
    if (role !== 'operations_viewer' || input.members.userList?.length !== 1) throw new UnauthorizedException();
    const id = input.members.userList[0].userID;
    await this.database.client.begin(async(tx)=>{
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`role:${id}`},0))`;
      await tx`INSERT INTO makit_role_override(user_id,role_id,allowed) VALUES(${id},${role},${!remove})
        ON CONFLICT(user_id,role_id) DO UPDATE SET allowed=EXCLUDED.allowed,updated_at=now()`;
      if (remove) await tx`DELETE FROM makit_user_role WHERE user_id = ${id} AND role_id = ${role}`;
      else await tx`INSERT INTO makit_user_role (user_id, role_id, source) VALUES (${id}, ${role}, 'native')
        ON CONFLICT(user_id,role_id) DO UPDATE SET source='native'`;
    });
  }
  readonly members = {
    add: (role: string, input: { members: MemberMutationData }) => this.change(role, input, false),
    remove: (role: string, input: { members: MemberMutationData }) => this.change(role, input, true),
  };
}
