import {provisionSuiteMember} from './suite-identity';
import { Injectable, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, CookieOptions } from 'express';
import { DrizzleDatabaseManager } from './database';
import type { MakitSessionProfile } from '../../../shared/selfhost-api';
import { FeishuService } from '../../modules/requirements/feishu.service';

const ISSUER = process.env.COBUILD_IDENTITY_ORIGIN || 'https://internal.110-lab.cn';
const nativeIdentity=()=>process.env.COBUILD_IDENTITY_MODE==='local';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{43}$/.test(value);
interface CentralProfile {
  issuer: string; audience: string; tenantKey: string; unionId: string;
  subject: string; name: string; expiresAt: string; token?: string; provider?:string;role?:string;email?:string;
}
interface SessionRow {
  user_id: string; name: string; employee_id: string; open_id: string; avatar_url: string;
  identity_token_ciphertext: string; expires_at: Date; subject: string;
  last_verified_at: Date;
}

function cookie(req: Request, name: string): string {
  const values = String(req.headers.cookie || '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}

@Injectable()
export class MakitSessionService {
  private readonly origin: string;
  private readonly key: Buffer;
  private readonly verified = new Map<string, number>();
  constructor(private readonly database: DrizzleDatabaseManager, private readonly feishu: FeishuService) {
    const url = new URL(process.env.MAKIT_PUBLIC_URL || '');
    if (url.origin !== process.env.MAKIT_PUBLIC_URL || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('Invalid public origin');
    this.origin = url.origin;
    const issuer=new URL(ISSUER);if(issuer.origin!==ISSUER||issuer.username||issuer.password||issuer.protocol!=='https:'&&!(issuer.protocol==='http:'&&['127.0.0.1','localhost'].includes(issuer.hostname)))throw new Error('Invalid identity issuer');
    if(nativeIdentity()&&!process.env.COBUILD_IDENTITY_ORIGIN)throw new Error('Explicit suite identity issuer required');
    const key=process.env.MAKIT_SESSION_ENCRYPTION_KEY || '';
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Missing session encryption key');
    this.key = Buffer.from(key, 'hex');
  }
  private encrypted(value: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
  }
  private decrypted(value: string): string {
    try {
      const bytes = Buffer.from(value, 'base64url'), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch { throw new UnauthorizedException('登录已失效'); }
  }
  private async central(action: string, input: Record<string, string>): Promise<CentralProfile> {
    let response: globalThis.Response;
    try {
      response = await fetch(`${ISSUER}/api/identity/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audience: 'requirements', ...input }),
        redirect: 'error', signal: AbortSignal.timeout(6000),
      });
    } catch { throw new ServiceUnavailableException('暂时无法核对统一身份'); }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new UnauthorizedException('登录已失效');
      throw new ServiceUnavailableException('暂时无法核对统一身份');
    }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body!) {
      if ((size += chunk.length) > 32768) throw new UnauthorizedException('身份响应无效');
      chunks.push(chunk);
    }
    const value: CentralProfile = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value.issuer !== ISSUER || value.audience !== 'requirements' ||
      value.tenantKey !== process.env.LAB_IDENTITY_TENANT_KEY ||
      !(nativeIdentity()?value.provider==='local'&&/^[0-9a-f-]{36}$/.test(value.unionId||''):/^on_[\w-]{10,100}$/.test(value.unionId || '')) ||
      value.subject !== `${value.tenantKey}:${value.unionId}` ||
      !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now() ||
      Date.parse(value.expiresAt) > Date.now() + 30 * 86400000 + 5000) throw new UnauthorizedException('身份响应无效');
    return value;
  }
  private cookieOptions(embedded: boolean): CookieOptions {
    return { httpOnly: true, secure: embedded || this.origin.startsWith('https:'), sameSite: embedded ? 'none' : 'lax', ...(embedded ? { partitioned: true } : {}), path: '/' };
  }
  private sessionContext(req: Request) {
    const embedded = String(req.headers.cookie || '').split(';').some(part => part.trim().startsWith('makit_embedded_session='));
    const name = embedded ? 'makit_embedded_session' : 'makit_session';
    return { embedded, name, token: cookie(req, name) };
  }
  async begin(req: Request, res: Response): Promise<void> {
    const embedded = req.query.embedded === '1';
    if (req.query.embedded !== undefined && !embedded) throw new UnauthorizedException('连接方式无效');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const flow = randomBytes(32).toString('base64url');
    const next = typeof req.query.next === 'string' ? req.query.next : '/';
    if (!next.startsWith('/') || next.startsWith('//') || /[\\\x00-\x1f]/u.test(next)) throw new UnauthorizedException();
    const sql = this.database.client;
    await sql`DELETE FROM makit_auth_flow WHERE expires_at <= now()`;
    await sql`INSERT INTO makit_auth_flow (token_hash, state, verifier, expires_at, return_path)
      VALUES (${hash((embedded ? 'embedded:' : '') + flow)}, ${state}, ${verifier}, now() + interval '10 minutes', ${next})`;
    res.cookie(embedded ? 'makit_embedded_flow' : 'makit_flow', flow, { ...this.cookieOptions(embedded), maxAge: 600000 });
    const url = new URL(embedded ? '/auth/embedded' : '/auth', ISSUER);
    url.search = new URLSearchParams({ audience: 'requirements', redirect_uri: `${this.origin}/callback/110lab_requirements${embedded ? '/embedded' : ''}`, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    res.redirect(302, url.href);
  }
  async callback(req: Request, res: Response, embedded = false): Promise<void> {
    const flowName = embedded ? 'makit_embedded_flow' : 'makit_flow';
    const flowCookie = cookie(req, flowName);
    if (!opaque(flowCookie) || !opaque(req.query.state) || !opaque(req.query.code) || req.query.iss !== ISSUER) throw new UnauthorizedException('连接请求已失效');
    const sql = this.database.client;
    const [flow] = await sql<{ state: string; verifier: string; return_path: string }[]>`
      DELETE FROM makit_auth_flow WHERE token_hash = ${hash((embedded ? 'embedded:' : '') + flowCookie)} AND expires_at > now()
      RETURNING state, verifier, return_path
    `;
    if (!flow || flow.state.length !== req.query.state.length || !timingSafeEqual(Buffer.from(flow.state), Buffer.from(req.query.state))) throw new UnauthorizedException('连接请求已失效');
    res.clearCookie(flowName, this.cookieOptions(embedded));
    const profile = await this.central('exchange', { code: req.query.code, state: flow.state, verifier: flow.verifier,
      redirectUri: `${this.origin}/callback/110lab_requirements${embedded ? '/embedded' : ''}` });
    if (!opaque(profile.token)) throw new UnauthorizedException();
    const member = nativeIdentity()?await provisionSuiteMember(sql,profile):await this.feishu.getUserByUnionId(profile.unionId);
    const [user] = await sql<{ id: string }[]>`
      SELECT id FROM makit_user WHERE subject = ${profile.subject} AND employee_id = ${member.employeeId} AND active
    `;
    // Provisioning and legacy mapping are explicit migration steps. A valid
    // central identity never silently acquires Makit access or administrator roles.
    if (!user) throw new UnauthorizedException('此成员尚未获准使用 Makit');
    const session = randomBytes(32).toString('base64url');
    await sql`INSERT INTO makit_session (token_hash, user_id, identity_token_ciphertext, expires_at,last_verified_at)
      VALUES (${hash((embedded ? 'embedded:' : '') + session)}, ${user.id}, ${this.encrypted(profile.token)}, ${profile.expiresAt},now())`;
    res.cookie(embedded ? 'makit_embedded_session' : 'makit_session', session, { ...this.cookieOptions(embedded),
      maxAge: Math.min(30 * 86400000, Date.parse(profile.expiresAt) - Date.now()), path: '/' });
    res.redirect(303, flow.return_path);
  }
  async authenticate(req: Request): Promise<MakitSessionProfile | null> {
    const { token: value, embedded } = this.sessionContext(req);
    if (!opaque(value)) return null;
    const sql = this.database.client, key = hash((embedded ? 'embedded:' : '') + value);
    const [row] = await sql<SessionRow[]>`
      SELECT s.*, u.subject, d.name, d.employee_id, d.open_id, d.avatar_url
      FROM makit_session s JOIN makit_user u ON u.id = s.user_id
      JOIN makit_directory d ON d.employee_id = u.employee_id
      WHERE s.token_hash = ${key} AND s.expires_at > now() AND u.active AND d.active
    `;
    if (!row) return null;
    if (nativeIdentity() || (this.verified.get(key) || 0) < Date.now()) {
      try {
        const central = await this.central('inspect', { token: this.decrypted(row.identity_token_ciphertext) });
        if (central.subject !== row.subject) throw new UnauthorizedException('登录身份不一致');
        // Refresh actual organization status and group-derived Makit roles, not
        // the central workbench role. A revoked member always fails closed.
        if(nativeIdentity())await provisionSuiteMember(sql,central);else await this.feishu.getUserByUnionId(central.unionId);
        await sql`UPDATE makit_session SET last_verified_at=now() WHERE token_hash=${key}`;
        this.verified.set(key, Date.now() + 30000);
        if (this.verified.size > 1000) for (const [key, expires] of this.verified) if (expires < Date.now()) this.verified.delete(key);
      } catch(error) {
        // A short identity-provider outage should not blank an already signed-in
        // user's read pages. This never renews the lease/cache or permits writes.
        const verifiedAge=Date.now()-new Date(row.last_verified_at).getTime();
        const recent=Number.isFinite(verifiedAge) && verifiedAge>=-5000 && verifiedAge<=5*60000;
        if (!( !nativeIdentity() && error instanceof ServiceUnavailableException && ['GET','HEAD'].includes(req.method) && recent)) throw error;
      }
    }
    const roles = await sql<{ role_id: string }[]>`SELECT role_id FROM makit_user_role WHERE user_id = ${row.user_id}`;
    return { user_id: row.user_id, name: { zh_cn: row.name }, employeeId: row.employee_id, openId: row.open_id,
      avatar: row.avatar_url, roles: roles.map((role) => role.role_id) };
  }
  assertOrigin(req: Request): void {
    if (req.headers.origin !== this.origin || req.headers['sec-fetch-site'] === 'cross-site') {
      throw new UnauthorizedException('请求来源无效');
    }
  }
  async logout(req: Request, res: Response): Promise<void> {
    this.assertOrigin(req);
    const { token, embedded, name } = this.sessionContext(req);
    if (opaque(token)) {
      const key = hash((embedded ? 'embedded:' : '') + token);
      await this.database.client`DELETE FROM makit_session WHERE token_hash = ${key}`;
      this.verified.delete(key);
    }
    res.clearCookie(name, this.cookieOptions(embedded));
    res.status(200).json({ success: true });
  }
}
