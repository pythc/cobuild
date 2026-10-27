import {createHmac} from 'node:crypto';
import {ForbiddenException,UnauthorizedException} from '@nestjs/common';
import type {Request,Response} from 'express';
import {RelayController} from '../../server/modules/relay/relay.controller';
import {issueWidgetGrant} from '../../server/modules/relay/widget-grant';
describe('Relay widget handoff boundary',()=>{
 const before=process.env.RELAY_WIDGET_SIGNING_KEY;
 beforeAll(()=>{process.env.RELAY_WIDGET_SIGNING_KEY='w'.repeat(43);});
 afterAll(()=>{if(before===undefined)delete process.env.RELAY_WIDGET_SIGNING_KEY;else process.env.RELAY_WIDGET_SIGNING_KEY=before;});
 it('requires the application session before issuing a handoff',async()=>{
  const c=new RelayController({} as never,{currentUser:jest.fn()} as never);
  await expect(c.route({userContext:undefined} as unknown as Request,{} as Response,{})).rejects.toBeInstanceOf(UnauthorizedException);
 });
 it('rejects a browser from a different origin before returning a signed identity',async()=>{
  const c=new RelayController({} as never,{currentUser:jest.fn(async()=>({employeeId:'employee',name:'Test'}))} as never);
  await expect(c.route({userContext:{userId:'local'},headers:{origin:'https://evil.test'},path:'/api/relay/widget-grant',method:'POST'} as unknown as Request,{setHeader:jest.fn()} as unknown as Response,{app:'makit',challenge:'x'.repeat(43)})).rejects.toBeInstanceOf(ForbiddenException);
 });
 it('signs only the authenticated subject and fixes application and audience',()=>{
  const response=issueWidgetGrant({subject:'employee',name:'Test'},'x'.repeat(43));
  const [payload,signature]=response.grant.split('.');
  expect(signature).toBe(createHmac('sha256','w'.repeat(43)).update(payload).digest('base64url'));
  expect(JSON.parse(Buffer.from(payload,'base64url').toString())).toMatchObject({sub:'employee',iss:'makit',app:'makit',aud:'relay-widget-v1',origin:'https://fcncvoyreb8p.feishuapp.com'});
  expect(()=>issueWidgetGrant({subject:'employee',name:'Test'},undefined)).toThrow();
 });
});
