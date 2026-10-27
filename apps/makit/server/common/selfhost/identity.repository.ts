import { Injectable, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { DrizzleDatabaseManager } from './database';
export interface VerifiedOrganizationMember {
  employeeId: string; openId: string; unionId: string; name: string; avatar: string; departments: string[];
}
interface Policy { scope: 'Tenant' | 'Range'; users: string[]; departments: string[]; chats: string[] }
interface Binding { role_id: string; kind: string; external_id: string }

/** Only a verified Feishu response can create an account. Platform roles are never inferred from a name. */
@Injectable()
export class MakitIdentityRepository {
  constructor(private readonly database: DrizzleDatabaseManager) {}
  async unionId(employeeId: string) {
    const [member]=await this.database.client<{union_id:string}[]>`SELECT union_id FROM makit_directory WHERE employee_id=${employeeId} AND active`;
    if (!member?.union_id) throw new UnauthorizedException('无法确认组织成员身份');
    return member.union_id;
  }
  async policy() {
    const sql = this.database.client;
    const [policy] = await sql<Policy[]>`SELECT * FROM makit_access_policy WHERE id`;
    if (!policy) throw new ServiceUnavailableException('应用访问范围尚未迁移');
    const bindings = await sql<Binding[]>`SELECT * FROM makit_role_binding`;
    return { policy, bindings, chats: [...new Set([...policy.chats,
      ...bindings.filter((binding) => binding.kind === 'chat').map((binding) => binding.external_id)])] };
  }
  async register(member: VerifiedOrganizationMember, chatIds: string[], configuration: Awaited<ReturnType<MakitIdentityRepository['policy']>>) {
    const tenant = process.env.LAB_IDENTITY_TENANT_KEY;
    if (!tenant || !member.employeeId || !/^ou_[\w-]+$/.test(member.openId) || !/^on_[\w-]+$/.test(member.unionId)) throw new UnauthorizedException('组织身份无效');
    const sql = this.database.client;
    const ancestry = await sql<{ id: string }[]>`WITH RECURSIVE parents AS (
      SELECT id,parent_id,ARRAY[id] AS seen FROM makit_department WHERE id IN ${sql(member.departments.length ? member.departments : [''])}
      UNION ALL SELECT d.id,d.parent_id,p.seen||d.id FROM makit_department d JOIN parents p ON d.id=p.parent_id WHERE NOT d.id=ANY(p.seen)
    ) SELECT DISTINCT id FROM parents`;
    const departments = new Set([...member.departments, ...ancestry.map((row) => row.id)]), chats = new Set(chatIds);
    const policy = configuration.policy;
    const allowed = policy.scope === 'Tenant' || policy.users.includes(member.openId) ||
      policy.departments.some((id) => departments.has(id)) || policy.chats.some((id) => chats.has(id));
    const roles = configuration.bindings.filter((binding) => binding.kind === 'user' ? binding.external_id === member.openId
      : binding.kind === 'chat' ? chats.has(binding.external_id) : departments.has(binding.external_id)).map((binding) => binding.role_id);
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`member:${member.employeeId}`},0))`;
      const updated = await tx`INSERT INTO makit_directory (employee_id,open_id,union_id,name,avatar_url,department_ids)
        VALUES (${member.employeeId},${member.openId},${member.unionId},${member.name},${member.avatar},${tx.json(member.departments)})
        ON CONFLICT(employee_id) DO UPDATE SET union_id=EXCLUDED.union_id,name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,
        department_ids=EXCLUDED.department_ids,active=true,updated_at=now() WHERE makit_directory.open_id=EXCLUDED.open_id
        RETURNING employee_id`;
      if (!updated.length) throw new UnauthorizedException('历史组织身份映射不一致');
      const [row] = await tx<{ id: string; subject: string }[]>`SELECT id,subject FROM makit_user WHERE employee_id=${member.employeeId}`;
      if (row && row.subject !== `${tenant}:${member.unionId}`) throw new UnauthorizedException('历史身份映射不一致');
      if (!allowed) {
        if (row) await tx`UPDATE makit_user SET active=false WHERE id=${row.id}`;
        return;
      }
      const id = row?.id || (await tx<{ id: string }[]>`SELECT nextval('makit_user_id_seq')::text AS id`)[0].id;
      await tx`INSERT INTO makit_user(id,subject,employee_id) VALUES(${id},${`${tenant}:${member.unionId}`},${member.employeeId})
        ON CONFLICT(id) DO UPDATE SET active=true`;
      // Serialize against explicit operations-role changes, preserving a removal
      // even if an imported legacy user/group binding still contains the role.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`role:${id}`},0))`;
      const overrides=await tx<{role_id:string;allowed:boolean}[]>`SELECT role_id,allowed FROM makit_role_override WHERE user_id=${id}`;
      await tx`DELETE FROM makit_user_role WHERE user_id=${id} AND source='legacy'`;
      for (const role of new Set(roles)) if(!overrides.some((entry)=>entry.role_id===role && !entry.allowed))
        await tx`INSERT INTO makit_user_role(user_id,role_id,source) VALUES(${id},${role},'legacy') ON CONFLICT DO NOTHING`;
    });
    if (!allowed) throw new UnauthorizedException('此成员不在 Makit 使用范围内');
  }
}
