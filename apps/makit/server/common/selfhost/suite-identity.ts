import { UnauthorizedException } from "@nestjs/common";
import type { Sql } from "postgres";

export interface SuiteProfile {
  issuer: string;
  subject: string;
  tenantKey: string;
  unionId: string;
  name: string;
  email?: string;
  role?: string;
  provider?: string;
}
export async function provisionSuiteMember(sql: Sql, profile: SuiteProfile) {
  if (
    profile.provider !== "local" ||
    !profile.name ||
    !profile.subject ||
    profile.subject !== profile.tenantKey + ":" + profile.unionId
  )
    throw new UnauthorizedException("组织身份无效");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cobuild-native-identity',0))`;
    let [binding] = await tx`SELECT * FROM makit_suite_organization WHERE id`;
    if (!binding) {
      const [{ count }] = await tx`SELECT count(*)::int count FROM makit_user`;
      if (count || profile.role !== "super_admin")
        throw new UnauthorizedException(
          "请由组织所有者初始化新的 Makit 空间；既有账号需显式迁移",
        );
      await tx`INSERT INTO makit_suite_organization(id,issuer,organization_id) VALUES(true,${profile.issuer},${profile.tenantKey})`;
      binding = { issuer: profile.issuer, organization_id: profile.tenantKey };
    }
    if (
      binding.issuer !== profile.issuer ||
      binding.organization_id !== profile.tenantKey
    )
      throw new UnauthorizedException("Makit 已绑定其他组织");
    const existing =
      await tx`SELECT * FROM makit_directory WHERE employee_id=${profile.unionId}`;
    if (existing.length && existing[0].union_id !== profile.unionId)
      throw new UnauthorizedException("组织身份映射冲突");
    await tx`INSERT INTO makit_directory(employee_id,open_id,union_id,name,avatar_url,department_ids,active)
      VALUES(${profile.unionId},${profile.unionId},${profile.unionId},${profile.name},'',${tx.json([])},true)
      ON CONFLICT(employee_id) DO UPDATE SET name=EXCLUDED.name,active=true,updated_at=now()`;
    let [user] =
      await tx`SELECT id,subject,active FROM makit_user WHERE subject=${profile.subject}`;
    if (user && !user.active)
      throw new UnauthorizedException("此 Makit 账号已停用");
    if (!user) {
      const [{ id }] = await tx`SELECT nextval('makit_user_id_seq')::text id`;
      await tx`INSERT INTO makit_user(id,subject,employee_id) VALUES(${id},${profile.subject},${profile.unionId})`;
      const [{ count }] = await tx`SELECT count(*)::int count FROM makit_user`;
      const role = count === 1 ? "admin" : "editor";
      await tx`INSERT INTO makit_user_role(user_id,role_id,source) VALUES(${id},${role},'native')`;
      user = { id };
    }
    // Existing application roles are never replaced by a central role.
    return {
      employeeId: profile.unionId,
      openId: profile.unionId,
      name: profile.name,
      id: user.id,
    };
  });
}
