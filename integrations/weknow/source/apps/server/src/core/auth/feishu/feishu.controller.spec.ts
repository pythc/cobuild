jest.mock('./lab-identity.service',()=>({LabIdentityService:class{}}));
import {LabIdentityService} from './lab-identity.service';
jest.mock('./feishu.service', () => ({ FeishuService: class FeishuService {} }));
import { ThrottlerGuard } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { FeishuController } from './feishu.controller';
import { FeishuService } from './feishu.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

describe('Feishu HTTP redirects',()=>{
 let app:NestFastifyApplication;
 const service={enabled:true,secure:false,cookieName:()=> 'state_cookie',begin:jest.fn(),complete:jest.fn()};
 beforeAll(async()=>{
  const module=await Test.createTestingModule({controllers:[FeishuController],providers:[{provide:LabIdentityService,useValue:{enabled:false}},{provide:FeishuService,useValue:service},{provide:EnvironmentService,useValue:{getCookieExpiresIn:()=>new Date(Date.now()+3600000)}}]}).overrideGuard(ThrottlerGuard).useValue({canActivate:()=>true}).compile();
  app=module.createNestApplication(new FastifyAdapter());
  await app.register(cookie as any);await app.init();await app.getHttpAdapter().getInstance().ready();
 });
 beforeEach(()=>jest.resetAllMocks());
 afterAll(async()=>await app.close());
 test('login sends an actual 302 rather than a 200 with Location',async()=>{
  service.begin.mockResolvedValue({url:'https://accounts.feishu.cn/authorize',state:'state',binding:'browser'});
  const r=await app.inject({method:'GET',url:'/auth/feishu/login?redirect=%2Fs%2Fgeneral'});
  expect(r.statusCode).toBe(302);expect(r.headers.location).toBe('https://accounts.feishu.cn/authorize');expect(r.headers['set-cookie']).toContain('HttpOnly');
  expect(service.begin).toHaveBeenCalledWith('/s/general');
 });
 test('callback restores the original document with a session cookie',async()=>{
  service.complete.mockResolvedValue({authToken:'session',redirect:'/s/general/p/design'});
  const r=await app.inject({method:'GET',url:'/auth/feishu/callback?state=state&code=code',headers:{cookie:'state_cookie=browser'}});
  expect(r.statusCode).toBe(302);expect(r.headers.location).toBe('/s/general/p/design');expect(r.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('authToken=session')]));
  expect(service.complete).toHaveBeenCalledWith('state','code','browser');
 });
 test('expired callback cannot set an authenticated session',async()=>{
  service.complete.mockRejectedValue(new Error('expired'));
  const r=await app.inject({method:'GET',url:'/auth/feishu/callback?state=state&code=code'});
  expect(r.statusCode).toBe(302);expect(r.headers.location).toBe('/login?error=failed');expect(String(r.headers['set-cookie'])).not.toContain('authToken=');
 });
 test('a cancelled grant has a recoverable login destination',async()=>{
  const r=await app.inject({method:'GET',url:'/auth/feishu/callback?error=access_denied'});
  expect(r.statusCode).toBe(302);expect(r.headers.location).toBe('/login?error=denied');expect(service.complete).not.toHaveBeenCalled();
 });
});
