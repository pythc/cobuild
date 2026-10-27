import postgres,{type Sql} from 'postgres';
import {randomUUID} from 'node:crypto';
import {provisionSuiteMember} from '../../server/common/selfhost/suite-identity';

describe('portable suite account continuity',()=>{
  let owner:Sql,app:Sql;
  const org=randomUUID(),first=randomUUID(),member=randomUUID(),issuer='http://127.0.0.1:49000';
  const profile=(id:string,role='member')=>({issuer,tenantKey:org,unionId:id,subject:org+':'+id,provider:'local',name:'Same Display Name',role});
  beforeAll(()=>{
    if(new URL(process.env.MAKIT_MIGRATION_DATABASE_URL||'').hostname!=='127.0.0.1')throw Error('Disposable local database required');
    owner=postgres(process.env.MAKIT_MIGRATION_DATABASE_URL!,{max:1});app=postgres(process.env.MAKIT_DATABASE_URL!,{max:1});
  });
  afterAll(async()=>{
    try {
    await owner`DELETE FROM makit_user_role WHERE user_id IN (SELECT id FROM makit_user WHERE subject IN (${org+':'+first},${org+':'+member}))`;
    await owner`DELETE FROM makit_user WHERE subject IN (${org+':'+first},${org+':'+member})`;
    await owner`DELETE FROM makit_directory WHERE employee_id IN (${first},${member})`;
    await owner`DELETE FROM makit_suite_organization`;
    } finally {await Promise.all([owner.end(),app.end()]);}
  });
  it('requires the organization owner for an empty database and provisions one stable owner',async()=>{
    await expect(provisionSuiteMember(app,profile(member))).rejects.toThrow('组织所有者');
    const a=await provisionSuiteMember(app,profile(first,'super_admin')),b=await provisionSuiteMember(app,profile(first,'super_admin'));
    expect(a.id).toBe(b.id);expect((await app`SELECT role_id FROM makit_user_role WHERE user_id=${a.id}`).map(r=>r.role_id)).toContain('admin');
  });
  it('separates equal names, preserves application roles, and never silently reactivates a suspended account',async()=>{
    const a=await provisionSuiteMember(app,profile(member));
    await provisionSuiteMember(app,profile(member,'admin'));
    const roles=await app`SELECT role_id FROM makit_user_role WHERE user_id=${a.id}`;
    expect(roles.map(r=>r.role_id)).toEqual(['editor']);
    expect(await app`SELECT id FROM makit_user WHERE subject=${org+':'+first}`).toHaveLength(1);
    await owner`UPDATE makit_user SET active=false WHERE id=${a.id}`;
    await expect(provisionSuiteMember(app,profile(member))).rejects.toThrow('停用');
  });
  it('rejects cross-organization rebinding and unregistered legacy data without merging accounts',async()=>{
    await expect(provisionSuiteMember(app,{...profile(first,'super_admin'),issuer:'http://127.0.0.1:49001'})).rejects.toThrow('其他组织');
    await owner`DELETE FROM makit_suite_organization`;
    await expect(provisionSuiteMember(app,profile(first,'super_admin'))).rejects.toThrow('显式迁移');
    expect(await app`SELECT id FROM makit_user WHERE subject LIKE ${org+':%'}`).toHaveLength(2);
  });
});
