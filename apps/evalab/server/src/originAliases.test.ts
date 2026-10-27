import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createContext, closeContext } from './context.js';
import { createPool } from './db.js';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { sha256Hex } from './security.js';
import { CONSENT_VERSION } from './policy.js';

const primary = 'https://exam.example.test';
const legacy = 'https://192.0.2.1';
const fixture = { DATABASE_URL:'postgres://localhost/fixture', NODE_ENV:'test', APP_ORIGIN:primary, PUBLIC_BASE_URL:primary };

test('legacy origins accept bounded exact HTTPS origins only', () => {
  assert.deepEqual(loadConfig(fixture).config.legacyAppOrigins, []);
  assert.deepEqual(loadConfig({...fixture,LEGACY_APP_ORIGINS:`${legacy},${primary},${legacy}`}).config.legacyAppOrigins,[legacy]);
  for (const value of ['http://old.test','https://*.example.test','https://old.test/path','https://u:p@old.test','https://old.test?q=1','https://old.test#x']) {
    assert.throws(()=>loadConfig({...fixture,LEGACY_APP_ORIGINS:value}));
  }
  assert.throws(()=>loadConfig({...fixture,LEGACY_APP_ORIGINS:Array.from({length:5},(_,i)=>`https://old${i}.test`).join(',')}));
  assert.throws(()=>loadConfig({...fixture,LEGACY_APP_ORIGINS:legacy,PUBLIC_BASE_URL:'https://different.test'}));
});

test('canonical and legacy hosts preserve their own OAuth origin, origin checks, and registration secrets',
  {skip:!process.env.TEST_DATABASE_URL && 'requires disposable PostgreSQL',timeout:30000}, async()=>{
    const url=process.env.TEST_DATABASE_URL!;
    const schema=`assessment_alias_${process.pid}`;
    Object.assign(process.env,{...fixture,DATABASE_URL:url,DB_SCHEMA:schema,LEGACY_APP_ORIGINS:legacy,
      SESSION_SECRET:'fictional-alias-fixture-secret-32-characters',COOKIE_SECURE:'true',MAIL_TEST_SINK:'true',SEED_DEMO:'false',
      ADMIN_EMAIL:'alias-admin@example.test',ADMIN_PASSWORD:'Fixture-password-123'});
    delete process.env.SMTP_HOST;delete process.env.EMBEDDING_ORIGINS;
    const ctx=await createContext();const server=createServer(createApp(ctx));
    try{
      server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert.ok(addr&&typeof addr!=='string');
      const base=`http://127.0.0.1:${addr.port}`;
      // Node fetch ignores Host overrides; a real proxy preserves the browser Host.
      const request=(origin:string,path:string,init:RequestInit={})=>new Promise<Response>((resolve,reject)=>{
        const req=httpRequest(base+path,{method:init.method??'GET',headers:{Host:new URL(origin).host,Origin:origin,'Content-Type':'application/json',...(init.headers as Record<string,string>)}},res=>{
          const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('error',reject);
          res.on('end',()=>{const headers=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2)headers.append(res.rawHeaders[i]!,res.rawHeaders[i+1]!);
            resolve(new Response(Buffer.concat(chunks),{status:res.statusCode!,headers}));});
        });req.on('error',reject);req.end(init.body?.toString());
      });
      for(const origin of [primary,legacy]){
        const meta=await request(origin,'/.well-known/oauth-authorization-server');assert.equal(meta.status,200);
        const data=await meta.json();assert.equal(data.issuer,origin);assert.equal(data.authorization_endpoint,origin+'/oauth/authorize');
        const resource=await (await request(origin,'/.well-known/oauth-protected-resource/mcp')).json();assert.equal(resource.resource,origin+'/mcp');
        const login=await request(origin,'/api/auth/login',{method:'POST',body:JSON.stringify({account:'alias-admin@example.test',password:'Fixture-password-123'})});assert.equal(login.status,200);
        const cross=await request(origin,'/api/auth/login',{method:'POST',headers:{Origin:origin===primary?legacy:primary},body:'{}'});assert.equal(cross.status,403);
        const email=(origin===primary?'primary':'legacy')+'@example.test';
        const issued=await request(origin,'/api/auth/registration-challenge?email='+email);assert.equal(issued.status,200);
        const cookie=issued.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');const challenge=await issued.json();
        const solution=await solveChallenge({challenge,deriveKey,timeout:60000});assert.ok(solution);
        const proof=Buffer.from(JSON.stringify({challenge,solution})).toString('base64');
        const sent=await request(origin,'/api/auth/email-code',{method:'POST',headers:{Cookie:cookie},body:JSON.stringify({email,purpose:'REGISTER',registrationProof:proof})});assert.equal(sent.status,200);
      }
      const untrusted=await request('https://evil.example','/.well-known/oauth-authorization-server',{headers:{'X-Forwarded-Host':new URL(legacy).host}});
      assert.equal((await untrusted.json()).issuer,primary);
      assert.equal((await fetch(base+'/api/health')).status,200);

      // Simulate an OAuth connection created before the domain migration.
      const user=(await ctx.pool.query("SELECT id FROM users WHERE email='alias-admin@example.test'")).rows[0];
      const round=(await ctx.pool.query("INSERT INTO rounds(name) VALUES('Alias fixture') RETURNING id")).rows[0];
      const batch=(await ctx.pool.query("INSERT INTO batches(round_id,name,opens_at,start_closes_at,status) VALUES($1,'Alias fixture',now()-interval '1 hour',now()+interval '1 day','OPEN') RETURNING id",[round.id])).rows[0];
      const enrollment=(await ctx.pool.query("INSERT INTO enrollments(user_id,round_id,batch_id,direction,consent_version,consent_accepted_at) VALUES($1,$2,$3,'PRODUCT',$4,now()) RETURNING id",[user.id,round.id,batch.id,CONSENT_VERSION])).rows[0];
      const clientId=randomUUID(),access='fixture-access-'+randomUUID(),refresh='fixture-refresh-'+randomUUID();
      await ctx.pool.query('INSERT INTO oauth_clients(client_id,metadata) VALUES($1,$2)',[clientId,{client_id:clientId,redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token']}]);
      const anchor=(await ctx.pool.query("INSERT INTO mcp_tokens(enrollment_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",[enrollment.id,sha256Hex(randomUUID())])).rows[0];
      const grant=(await ctx.pool.query('INSERT INTO oauth_grants(client_id,mcp_token_id,resource) VALUES($1,$2,$3) RETURNING id',[clientId,anchor.id,legacy+'/mcp'])).rows[0];
      await ctx.pool.query('INSERT INTO oauth_access_tokens(token_hash,grant_id) VALUES($1,$2)',[sha256Hex(access),grant.id]);
      await ctx.pool.query('INSERT INTO oauth_refresh_tokens(token_hash,grant_id) VALUES($1,$2)',[sha256Hex(refresh),grant.id]);
      const mcp=(origin:string,token:string)=>request(origin,'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'alias-test',version:'0'}}})});
      assert.equal((await mcp(legacy,access)).status,200,'existing legacy access token works');
      assert.equal((await mcp(primary,access)).status,401,'tokens remain bound to their resource');
      const rotated=await request(legacy,'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:refresh,resource:legacy+'/mcp'})});
      assert.equal(rotated.status,200,'existing legacy refresh token works');
      assert.equal((await mcp(legacy,(await rotated.json()).access_token)).status,200);
      assert.equal(ctx.config.appOrigin,primary);assert.equal(ctx.config.publicBaseUrl,primary);
      assert.equal(Object.keys(ctx.config).includes('sessionSecret'),false);
    }finally{
      await new Promise<void>(resolve=>server.close(()=>resolve()));await closeContext(ctx);
      const cleanup=createPool(url,schema);await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);await cleanup.end();
    }
  });
