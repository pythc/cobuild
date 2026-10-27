import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { MakitIdentityRepository } from '../../server/common/selfhost/identity.repository';

describe('native member provisioning and permission continuity',()=>{
  let owner:Sql,app:Sql,repository:MakitIdentityRepository;
  const suffix=randomUUID().replaceAll('-','');
  const member={employeeId:`test-${suffix}`,openId:`ou_${suffix}`,unionId:`on_${suffix}`,name:'迁移验收成员',avatar:'',departments:[]};
  const config={policy:{scope:'Tenant' as const,users:[],departments:[],chats:[]},bindings:[],chats:[]};
  beforeAll(()=>{
    if(new URL(process.env.MAKIT_MIGRATION_DATABASE_URL || '').hostname!=='127.0.0.1') throw new Error('Local isolated database only');
    owner=postgres(process.env.MAKIT_MIGRATION_DATABASE_URL!,{max:1}); app=postgres(process.env.MAKIT_DATABASE_URL!,{max:1});
    repository=new MakitIdentityRepository({client:app} as never);
  });
  afterAll(async()=>{
    await owner`DELETE FROM makit_user_role WHERE user_id IN (SELECT id FROM makit_user WHERE employee_id=${member.employeeId})`;
    await owner`DELETE FROM makit_user WHERE employee_id=${member.employeeId}`;
    await owner`DELETE FROM makit_directory WHERE employee_id=${member.employeeId}`;
    await Promise.all([owner.end(),app.end()]);
  });
  it('creates one stable string ID for an eligible new organization member without elevating roles',async()=>{
    await repository.register(member,[],config); await repository.register(member,[],config);
    const users=await app`SELECT id,subject FROM makit_user WHERE employee_id=${member.employeeId}`;
    expect(users).toHaveLength(1); expect(BigInt(users[0].id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(users[0].subject).toBe(`${process.env.LAB_IDENTITY_TENANT_KEY}:${member.unionId}`);
    expect(await app`SELECT * FROM makit_user_role WHERE user_id=${users[0].id}`).toHaveLength(0);
  });
  it('re-evaluates group-derived roles while preserving a local operations grant',async()=>{
    const bindings=[{role_id:'admin',kind:'chat',external_id:'oc_test'}];
    await repository.register(member,['oc_test'],{...config,bindings});
    const [u]=await app`SELECT id FROM makit_user WHERE employee_id=${member.employeeId}`;
    await app`INSERT INTO makit_user_role(user_id,role_id,source) VALUES(${u.id},'operations_viewer','native')`;
    await repository.register(member,[],{...config,bindings});
    const roles=await app`SELECT role_id,source FROM makit_user_role WHERE user_id=${u.id}`;
    expect(roles).toEqual(expect.arrayContaining([{role_id:'operations_viewer',source:'native'}]));
    expect(roles.some((r)=>r.role_id==='admin')).toBe(false);
  });
  it('fails closed on revoked application access and conflicting legacy identities',async()=>{
    await expect(repository.register(member,[],{...config,policy:{...config.policy,scope:'Range'}})).rejects.toThrow('使用范围');
    expect((await app`SELECT active FROM makit_user WHERE employee_id=${member.employeeId}`)[0].active).toBe(false);
    await expect(repository.register({...member,unionId:`on_changed_${suffix}`},[],config)).rejects.toThrow('映射不一致');
    await expect(repository.register({...member,openId:`ou_changed_${suffix}`},[],config)).rejects.toThrow('映射不一致');
    await repository.register(member,[],config);
    expect((await app`SELECT active FROM makit_user WHERE employee_id=${member.employeeId}`)[0].active).toBe(true);
  });
  it('keeps an explicit operations-role removal across legacy group refreshes',async()=>{
    const [u]=await app`SELECT id FROM makit_user WHERE employee_id=${member.employeeId}`;
    const bindings=[{role_id:'operations_viewer',kind:'chat',external_id:'oc_operations'}];
    await app`DELETE FROM makit_user_role WHERE user_id=${u.id} AND role_id='operations_viewer'`;
    await app`INSERT INTO makit_role_override(user_id,role_id,allowed) VALUES(${u.id},'operations_viewer',false)`;
    await repository.register(member,['oc_operations'],{...config,bindings});
    expect(await app`SELECT role_id FROM makit_user_role WHERE user_id=${u.id} AND role_id='operations_viewer'`).toHaveLength(0);
  });
});
