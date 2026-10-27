import { createCipheriv } from 'node:crypto';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { MakitSessionService } from '../../server/common/selfhost/session.service';
import { transportAllowed } from '../../server/common/selfhost/access.guard';

describe('native identity verification and bounded provider-outage behavior',()=>{
  const environment={...process.env},originalFetch=global.fetch;
  const subject='tenant-test:on_0123456789012345',session='s'.repeat(43);
  beforeEach(()=>{
    process.env.MAKIT_PUBLIC_URL='http://127.0.0.1:5450';
    process.env.MAKIT_SESSION_ENCRYPTION_KEY='ab'.repeat(32);
    process.env.LAB_IDENTITY_TENANT_KEY='tenant-test';
  });
  afterEach(()=>{process.env={...environment};global.fetch=originalFetch;});
  function fixture(age=1000) {
    const cipher=createCipheriv('aes-256-gcm',Buffer.from(process.env.MAKIT_SESSION_ENCRYPTION_KEY!,'hex'),Buffer.alloc(12));
    const encrypted=Buffer.concat([cipher.update('t'.repeat(43)),cipher.final()]);
    const row={user_id:'legacy-user',subject,name:'Tester',employee_id:'tester',open_id:'ou_test',avatar_url:'',
      identity_token_ciphertext:Buffer.concat([Buffer.alloc(12),cipher.getAuthTag(),encrypted]).toString('base64url'),
      expires_at:new Date(Date.now()+3600000),last_verified_at:new Date(Date.now()-age)};
    const queries:string[]=[];
    const sql=async(strings:TemplateStringsArray)=>{const text=strings.join('?');queries.push(text);
      return text.includes('FROM makit_session s')?[row]:text.includes('SELECT role_id')?[{role_id:'viewer'}]:[];};
    const feishu={getUserByUnionId:jest.fn(async()=>({}))};
    return {service:new MakitSessionService({client:sql} as never,feishu as never),queries,feishu};
  }
  const request=(method='GET')=>({method,headers:{cookie:`makit_session=${session}`}} as never);
  it('allows only recently verified read pages during a transient provider outage',async()=>{
    global.fetch=jest.fn(async()=>{throw Error('offline');}) as never;
    const f=fixture();expect((await f.service.authenticate(request()))?.user_id).toBe('legacy-user');
    expect(f.queries.some(q=>q.includes('UPDATE makit_session'))).toBe(false);
    await expect(f.service.authenticate(request('POST'))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects stale reads and explicit revocation instead of extending the session',async()=>{
    global.fetch=jest.fn(async()=>{throw Error('offline');}) as never;
    await expect(fixture(301000).service.authenticate(request())).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(fixture(-60000).service.authenticate(request())).rejects.toBeInstanceOf(ServiceUnavailableException);
    global.fetch=jest.fn(async()=>new Response('{}',{status:401})) as never;
    await expect(fixture().service.authenticate(request())).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('refreshes real organization permissions and persists the last successful verification',async()=>{
    global.fetch=jest.fn(async()=>new Response(JSON.stringify({issuer:'https://internal.110-lab.cn',audience:'requirements',tenantKey:'tenant-test',
      unionId:'on_0123456789012345',subject,expiresAt:new Date(Date.now()+3600000).toISOString()}))) as never;
    const f=fixture();expect((await f.service.authenticate(request()))?.roles).toEqual(['viewer']);
    expect(f.feishu.getUserByUnionId).toHaveBeenCalledWith('on_0123456789012345');
    expect(f.queries.some(q=>q.includes('UPDATE makit_session'))).toBe(true);
    await f.service.authenticate(request());expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not use read grace for an explicit organization-membership rejection',async()=>{
    global.fetch=jest.fn(async()=>new Response(JSON.stringify({issuer:'https://internal.110-lab.cn',audience:'requirements',tenantKey:'tenant-test',
      unionId:'on_0123456789012345',subject,expiresAt:new Date(Date.now()+3600000).toISOString()}))) as never;
    const f=fixture();f.feishu.getUserByUnionId.mockRejectedValue(new UnauthorizedException());
    await expect(f.service.authenticate(request())).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('requires a complete valid encryption key and keeps machine transport keys scoped',()=>{
    process.env.MAKIT_SESSION_ENCRYPTION_KEY='ab'.repeat(32)+'z';expect(()=>fixture()).toThrow('encryption key');
    process.env.MCP_TRANSPORT_API_KEY='m'.repeat(43);process.env.MAKIT_PROJECT_SYNC_TRANSPORT_KEY='p'.repeat(43);process.env.MAKIT_IDENTITY_TRANSPORT_KEY='i'.repeat(43);
    expect(transportAllowed({path:'/openapi/mcp',headers:{authorization:'Bearer '+process.env.MCP_TRANSPORT_API_KEY}} as never)).toBe(true);
    expect(transportAllowed({path:'/openapi/workspace/projects/sync',headers:{authorization:'Bearer '+process.env.MCP_TRANSPORT_API_KEY}} as never)).toBe(false);
    expect(transportAllowed({path:'/api/workspace',headers:{authorization:'Bearer '+process.env.MCP_TRANSPORT_API_KEY}} as never)).toBe(false);
    expect(transportAllowed({path:'/openapi/identity/connect',headers:{authorization:'Bearer '+process.env.MCP_TRANSPORT_API_KEY}} as never)).toBe(false);
    expect(transportAllowed({path:'/openapi/identity/connect',headers:{authorization:'Bearer '+process.env.MAKIT_IDENTITY_TRANSPORT_KEY}} as never)).toBe(true);
  });
});

describe('Makit embedded browser login',()=>{
 const environment={...process.env},originalFetch=global.fetch;
 const hash=(value:string)=>require('node:crypto').createHash('sha256').update(value).digest('hex');
 beforeEach(()=>{process.env.MAKIT_PUBLIC_URL='https://makit.110-lab.cn';process.env.MAKIT_SESSION_ENCRYPTION_KEY='ab'.repeat(32);process.env.LAB_IDENTITY_TENANT_KEY='tenant-test';});
 afterEach(()=>{process.env={...environment};global.fetch=originalFetch;});
 function harness(){
  const flows=new Map<string,any>(),sessions=new Map<string,any>();
  const sql=async(strings:TemplateStringsArray,...v:any[])=>{const q=strings.join('?');
   if(q.includes('INSERT INTO makit_auth_flow'))flows.set(v[0],{state:v[1],verifier:v[2],return_path:v[3]});
   if(q.includes('DELETE FROM makit_auth_flow WHERE token_hash')){const row=flows.get(v[0]);flows.delete(v[0]);return row?[row]:[];}
   if(q.includes('SELECT id FROM makit_user'))return [{id:'existing-user'}];
   if(q.includes('INSERT INTO makit_session'))sessions.set(v[0],{user_id:v[1]});
   if(q.includes('DELETE FROM makit_session'))sessions.delete(v[0]);
   if(q.includes('FROM makit_session s'))return [];
   return [];
  };
  const service=new MakitSessionService({client:sql} as never,{getUserByUnionId:async()=>({employeeId:'tester'})} as never);
  const response=()=>{const res:any={cookie:jest.fn(),clearCookie:jest.fn(),redirect:jest.fn(),json:jest.fn(),status:jest.fn()};res.status.mockReturnValue(res);return res;};
  global.fetch=jest.fn(async()=>new Response(JSON.stringify({issuer:'https://internal.110-lab.cn',audience:'requirements',tenantKey:'tenant-test',unionId:'on_0123456789012345',subject:'tenant-test:on_0123456789012345',name:'Fixture',token:'t'.repeat(43),expiresAt:new Date(Date.now()+3600000).toISOString()}))) as never;
  return {service,flows,sessions,response};
 }
 it.each([false,true])('completes the correct callback and sets isolated browser cookies (embedded=%s)',async embedded=>{
  const h=harness(),r=h.response();await h.service.begin({query:{next:'/requirements?tab=mine',...(embedded?{embedded:'1'}:{})}} as never,r);
  const [name,value,options]=r.cookie.mock.calls[0],url=new URL(r.redirect.mock.calls[0][1]);
  expect(name).toBe(embedded?'makit_embedded_flow':'makit_flow');expect(options).toMatchObject({httpOnly:true,secure:true,sameSite:embedded?'none':'lax'});expect(options.partitioned).toBe(embedded?true:undefined);
  expect(url.pathname).toBe(embedded?'/auth/embedded':'/auth');
  const callback='https://makit.110-lab.cn/callback/110lab_requirements'+(embedded?'/embedded':'');expect(url.searchParams.get('redirect_uri')).toBe(callback);
  const req:any={headers:{cookie:`${name}=${value}`},query:{state:url.searchParams.get('state'),code:'c'.repeat(43),iss:'https://internal.110-lab.cn'}};
  const cb=h.response();await h.service.callback(req,cb,embedded);
  expect(h.flows.size).toBe(0);expect(h.sessions.size).toBe(1);
  const [sessionName,token,sessionOptions]=cb.cookie.mock.calls[0];expect(sessionName).toBe(embedded?'makit_embedded_session':'makit_session');expect(sessionOptions.partitioned).toBe(embedded?true:undefined);
  expect(h.sessions.has(hash((embedded?'embedded:':'')+token))).toBe(true);
  expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).redirectUri).toBe(callback);
  expect(cb.redirect).toHaveBeenCalledWith(303,'/requirements?tab=mine');
  await expect(h.service.callback(req,h.response(),embedded)).rejects.toBeInstanceOf(UnauthorizedException);
  const logout=h.response();await h.service.logout({headers:{origin:'https://makit.110-lab.cn',cookie:`${sessionName}=${token}`}} as never,logout);
  expect(h.sessions.size).toBe(0);expect(logout.clearCookie).toHaveBeenCalledWith(sessionName,expect.objectContaining({sameSite:embedded?'none':'lax',...(embedded?{partitioned:true}:{})}));
 });
 it('rejects transplanted flows, duplicate cookies, bad state and cross-site writes',async()=>{
  const h=harness(),r=h.response();await h.service.begin({query:{embedded:'1'}} as never,r);
  const [,value]=r.cookie.mock.calls[0],url=new URL(r.redirect.mock.calls[0][1]);
  const query={state:url.searchParams.get('state'),code:'c'.repeat(43),iss:'https://internal.110-lab.cn'};
  await expect(h.service.callback({query,headers:{cookie:'makit_flow='+value}} as never,h.response())).rejects.toBeInstanceOf(UnauthorizedException);
  expect(h.flows.size).toBe(1);
  await expect(h.service.callback({query,headers:{cookie:`makit_embedded_flow=${value}; makit_embedded_flow=${value}`}} as never,h.response(),true)).rejects.toBeInstanceOf(UnauthorizedException);
  await expect(h.service.callback({query:{...query,state:'x'.repeat(43)},headers:{cookie:'makit_embedded_flow='+value}} as never,h.response(),true)).rejects.toBeInstanceOf(UnauthorizedException);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(()=>h.service.assertOrigin({headers:{origin:'https://evil.example','sec-fetch-site':'cross-site'}} as never)).toThrow();
  await expect(h.service.begin({query:{embedded:['1','1']}} as never,r)).rejects.toBeInstanceOf(UnauthorizedException);
 });
});
