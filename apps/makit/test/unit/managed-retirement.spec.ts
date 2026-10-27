import type { Server } from 'node:http';
import { once } from 'node:events';
import { managedRetirementApp } from '../../server/managed-retirement';

describe('retired managed entry single-writer boundary', () => {
  let server: Server;
  afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });
  async function start(mode: string, forward?: typeof fetch) {
    server = managedRetirementApp(mode, forward).listen(0, '127.0.0.1'); await once(server, 'listening');
    const address=server.address(); if (!address || typeof address === 'string') throw Error();
    return `http://127.0.0.1:${address.port}`;
  }
  it('maintenance denies reads and writes without forwarding or constructing business workers', async () => {
    const forward=jest.fn(); const base=await start('maintenance',forward);
    for (const path of ['/openapi/mcp','/api/workspace/requirements','/requirements']) {
      const r=await fetch(base+path,{method:'POST',body:'{}'}); expect(r.status).toBe(503);
      expect(r.headers.get('retry-after')).toBe('30');
    }
    expect(forward).not.toHaveBeenCalled();
    expect(await (await fetch(base+'/healthz')).json()).toMatchObject({workers:false,mode:'maintenance'});
  });
  it('preserves machine body bytes, scoped credentials, and status but strips platform/browser identity', async () => {
    const forward=jest.fn(async()=>new Response('{"ok":true}',{status:201,headers:{'content-type':'application/json','set-cookie':'unsafe=test'}}));
    const base=await start('forward',forward as never),body=JSON.stringify({jsonrpc:'2.0',id:1,clientMutationId:'stable-123',text:'中文'});
    const r=await fetch(base+'/app/app_17b6pxwde0x/openapi/mcp',{method:'POST',headers:{authorization:'Bearer original-key','x-requirement-mcp-token':'original-personal-key',cookie:'old-platform-cookie=x','x-user-id':'forged','content-type':'application/json'},body});
    expect(r.status).toBe(201); expect(r.headers.get('set-cookie')).toBeNull();
    const [url,options]=forward.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://makit.110-lab.cn/openapi/mcp');
    expect(options.headers).toMatchObject({authorization:'Bearer original-key','x-requirement-mcp-token':'original-personal-key'});
    expect(options.headers).not.toHaveProperty('cookie'); expect(options.headers).not.toHaveProperty('x-user-id');
    expect(Buffer.from(options.body as never).toString()).toBe(body); expect(options.redirect).toBe('error');
  });
  it('redirects navigation and legacy files to the fixed native origin and rejects obsolete browser mutations', async () => {
    const forward=jest.fn(),base=await start('forward',forward);
    const r=await fetch(base+'/requirements/rec1?tab=details',{redirect:'manual'});
    expect(r.status).toBe(302); expect(r.headers.get('location')).toBe('https://makit.110-lab.cn/requirements/rec1?tab=details');
    expect((await fetch(base+'/api/workspace/requirements',{method:'POST',body:'{}'})).status).toBe(410);
    expect(forward).not.toHaveBeenCalled();
  });
  it('does not automatically retry an unknown write result', async () => {
    const forward=jest.fn(async()=>{throw Error('timeout');}),base=await start('forward',forward);
    expect((await fetch(base+'/openapi/mcp',{method:'POST',body:'{}'})).status).toBe(502);
    expect(forward).toHaveBeenCalledTimes(1);
  });
  it('refuses an implicit operating mode', () => { expect(()=>managedRetirementApp('')).toThrow(); });
});
