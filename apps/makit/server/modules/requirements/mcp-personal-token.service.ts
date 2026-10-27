import {
  constants,
  createCipheriv,
  createHmac,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import type {
  CurrentUserSummary,
  McpCredentialResponse,
  McpCredentialStatus,
  McpEncryptedCredentialResponse,
} from '@shared/api.interface';
import type { VerifiedMcpUser } from './mcp-auth.types';
import { RequirementAccessService } from './requirement-access.service';
import { RequirementPlatformRoleService } from './requirement-platform-role.service';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
const TOKEN_PREFIX = 'rmcp_v1';
const MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_PUBLIC_KEY_LENGTH = 2048;
const REQUEST_NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const MCP_ROLES: ReadonlySet<string> = new Set([
  'admin',
  'editor',
  'viewer',
]);

interface McpConfiguration {
  audience: string;
  endpoint: string;
  personalTokenSecret: string;
  transportApiKey: string;
}

interface McpTokenPayload {
  version: 1;
  audience: string;
  credentialId: string;
  tokenVersion: number;
  miaodaUserId: string;
  employeeId: string;
  openId: string;
  name: string;
  roles: string[];
}

interface McpCredentialRecord {
  id: string;
  tokenVersion: number;
  revokedAt: Date | null;
}

interface McpCredentialRow extends Record<string, unknown> {
  credential_id: string;
  token_version: number;
  revoked_at: Date | string | null;
}

interface McpCredentialVerificationRow extends Record<string, unknown> {
  valid: boolean;
}

function environmentValue(name: string): string {
  const value: string = process.env[name]?.trim() || '';
  if (!value) {
    throw new ServiceUnavailableException('MCP 接入尚未完成配置');
  }
  return value;
}

function configuration(): McpConfiguration {
  const personalTokenSecret: string = environmentValue(
    'MCP_PERSONAL_TOKEN_SECRET',
  );
  if (Buffer.byteLength(personalTokenSecret, 'utf8') < MINIMUM_SECRET_BYTES) {
    throw new ServiceUnavailableException('MCP 签名密钥强度不足');
  }
  return {
    audience: environmentValue('MCP_TOKEN_AUDIENCE'),
    endpoint: environmentValue('MCP_PUBLIC_ENDPOINT'),
    personalTokenSecret,
    transportApiKey: environmentValue('MCP_TRANSPORT_API_KEY'),
  };
}

function validString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new UnauthorizedException('个人 MCP Key 无效');
  }
  return value;
}

@Injectable()
export class McpPersonalTokenService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly platformRoles: RequirementPlatformRoleService,
    private readonly access: RequirementAccessService,
    private readonly serviceRoleDatabase: ServiceRoleDatabaseExecutor,
  ) {}

  // Only called after a live central grant, tenant, directory ID and platform
  // role check. The service transaction never inherits caller supplied claims.
  async issueForLabIdentity(currentUser:CurrentUserSummary):Promise<McpCredentialResponse>{
    this.ensureUserCanUseMcp(currentUser);
    const subjectHash=this.subjectHash(currentUser.miaodaUserId);
    const rows=await this.serviceRoleDatabase.run(async db=>{
      await db.execute(sql`SELECT set_config('app.user_id',${currentUser.miaodaUserId},true)`);
      return db.execute<McpCredentialRow>(sql`SELECT * FROM mcp_personal_credential_get(${subjectHash}::varchar)`);
    });
    if(!rows[0])throw new HttpException({code:'NATIVE_CONNECTION_REQUIRED',message:'请先在需求平台确认首次连接'},412);
    const record=this.toRecord(rows[0]);if(record.revokedAt)throw new HttpException({code:'NATIVE_CREDENTIAL_REVOKED',message:'此连接已停用，请在需求平台恢复后再连接'},410);
    return this.response(record,currentUser);
  }

  async issue(currentUser: CurrentUserSummary): Promise<McpCredentialResponse> {
    this.ensureUserCanUseMcp(currentUser);
    const record: McpCredentialRecord = await this.upsert(currentUser);
    if (record.revokedAt) {
      throw new UnauthorizedException(
        '个人 MCP Key 已停用，请重新生成后再使用',
      );
    }
    return this.response(record, currentUser);
  }

  async issueEncrypted(
    currentUser: CurrentUserSummary,
    encodedPublicKey: string,
    requestNonce: string,
  ): Promise<McpEncryptedCredentialResponse> {
    const publicKey: KeyObject = this.parseEncryptionKey(encodedPublicKey);
    const validNonce: string = this.parseRequestNonce(requestNonce);
    return this.encryptResponse(
      await this.issue(currentUser),
      publicKey,
      validNonce,
    );
  }

  async rotate(
    currentUser: CurrentUserSummary,
  ): Promise<McpCredentialResponse> {
    this.ensureUserCanUseMcp(currentUser);
    const record: McpCredentialRecord = await this.mutateCredential(
      currentUser.miaodaUserId,
      true,
    );
    return this.response(record, currentUser);
  }

  async rotateEncrypted(
    currentUser: CurrentUserSummary,
    encodedPublicKey: string,
    requestNonce: string,
  ): Promise<McpEncryptedCredentialResponse> {
    const publicKey: KeyObject = this.parseEncryptionKey(encodedPublicKey);
    const validNonce: string = this.parseRequestNonce(requestNonce);
    return this.encryptResponse(
      await this.rotate(currentUser),
      publicKey,
      validNonce,
    );
  }

  async status(currentUser: CurrentUserSummary): Promise<McpCredentialStatus> {
    this.ensureUserCanUseMcp(currentUser);
    let mcpConfiguration: McpConfiguration | null = null;
    try {
      mcpConfiguration = configuration();
    } catch {
      mcpConfiguration = null;
    }
    const record: McpCredentialRecord | null = mcpConfiguration
      ? await this.findByUserId(currentUser.miaodaUserId, mcpConfiguration)
      : null;
    const issued: boolean = Boolean(record && !record.revokedAt);
    const personalToken: string =
      mcpConfiguration && record && !record.revokedAt
        ? this.sign(record, currentUser, mcpConfiguration)
        : '';
    return {
      available: Boolean(mcpConfiguration),
      issued,
      endpoint: mcpConfiguration?.endpoint || '',
      personalTokenPreview: personalToken ? this.preview(personalToken) : '',
      userName: currentUser.name,
    };
  }

  async verify(personalToken: string): Promise<VerifiedMcpUser> {
    const payload: McpTokenPayload = this.parse(personalToken);
    const currentSubjectHash: string = this.subjectHash(payload.miaodaUserId);
    const rows = await this.db.execute<McpCredentialVerificationRow>(
      sql`
        SELECT mcp_personal_credential_verify(
          ${payload.credentialId}::uuid,
          ${payload.tokenVersion}::integer,
          ${currentSubjectHash}::varchar
        ) AS valid
      `,
    );
    if (!rows[0]?.valid) {
      throw new UnauthorizedException('个人 MCP Key 已失效');
    }
    const currentPlatformRoleIds: string[] =
      await this.platformRoles.currentRoles(payload.miaodaUserId);
    await this.syncReviewerRoles(
      payload,
      currentSubjectHash,
      currentPlatformRoleIds,
    );
    const currentUser: CurrentUserSummary = this.access.decorate({
      miaodaUserId: payload.miaodaUserId,
      employeeId: payload.employeeId,
      openId: payload.openId,
      name: payload.name,
      platformAppId:
        process.env.REQUIREMENT_PLATFORM_APP_ID?.trim() ||
        process.env.MIAODA_APP_ID?.trim() ||
        '',
      platformRoleIds: currentPlatformRoleIds,
    });
    return {
      ...currentUser,
      mcpWriteProof: {
        credentialId: payload.credentialId,
        tokenVersion: payload.tokenVersion,
        subjectHash: currentSubjectHash,
      },
    };
  }

  private async syncReviewerRoles(
    payload: McpTokenPayload,
    subjectHash: string,
    currentPlatformRoleIds: string[],
  ): Promise<void> {
    const normalizedRoleIds: string[] = [
      ...new Set(
        currentPlatformRoleIds.filter((roleId: string): boolean =>
          MCP_ROLES.has(roleId),
        ),
      ),
    ].sort();
    await this.serviceRoleDatabase.run(
      (database: PostgresJsDatabase): Promise<unknown> =>
        database.execute(sql`
          SELECT mcp_personal_credential_reviewer_roles_sync(
            ${payload.credentialId}::uuid,
            ${payload.tokenVersion}::integer,
            ${subjectHash}::varchar,
            ${payload.miaodaUserId}::text,
            ${JSON.stringify(normalizedRoleIds)}::jsonb
          )
        `),
    );
  }

  private async upsert(
    currentUser: CurrentUserSummary,
  ): Promise<McpCredentialRecord> {
    return this.mutateCredential(currentUser.miaodaUserId, false);
  }

  private async findByUserId(
    miaodaUserId: string,
    mcpConfiguration: McpConfiguration,
  ): Promise<McpCredentialRecord | null> {
    const subjectHash: string = this.subjectHash(
      miaodaUserId,
      mcpConfiguration,
    );
    const rows = await this.db.execute<McpCredentialRow>(
      sql`
        SELECT *
        FROM mcp_personal_credential_get(${subjectHash}::varchar)
      `,
    );
    return rows[0] ? this.toRecord(rows[0]) : null;
  }

  private async mutateCredential(
    miaodaUserId: string,
    rotate: boolean,
  ): Promise<McpCredentialRecord> {
    const subjectHash: string = this.subjectHash(miaodaUserId);
    const rows = await this.db.execute<McpCredentialRow>(
      sql`
        SELECT *
        FROM mcp_personal_credential_issue(
          ${subjectHash}::varchar,
          ${rotate}::boolean
        )
      `,
    );
    if (!rows[0]) {
      throw new ServiceUnavailableException(
        rotate ? '个人 MCP Key 重新生成失败' : '个人 MCP Key 获取失败',
      );
    }
    return this.toRecord(rows[0]);
  }

  private toRecord(row: McpCredentialRow): McpCredentialRecord {
    return {
      id: row.credential_id,
      tokenVersion: Number(row.token_version),
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    };
  }

  private response(
    record: McpCredentialRecord,
    currentUser: CurrentUserSummary,
  ): McpCredentialResponse {
    const mcpConfiguration: McpConfiguration = configuration();
    const personalToken: string = this.sign(
      record,
      currentUser,
      mcpConfiguration,
    );
    return {
      available: true,
      issued: true,
      endpoint: mcpConfiguration.endpoint,
      openApiKey: mcpConfiguration.transportApiKey,
      personalToken,
      personalTokenPreview: this.preview(personalToken),
      userName: currentUser.name,
    };
  }

  private encryptResponse(
    response: McpCredentialResponse,
    publicKey: KeyObject,
    requestNonce: string,
  ): McpEncryptedCredentialResponse {
    const contentKey: Buffer = randomBytes(32);
    const iv: Buffer = randomBytes(12);
    const plaintext: Buffer = Buffer.from(JSON.stringify(response), 'utf8');
    try {
      const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
      cipher.setAAD(this.encryptionContext(requestNonce));
      const encryptedPayload: Buffer = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      const encryptedKey: Buffer = publicEncrypt(
        {
          key: publicKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        contentKey,
      );
      return {
        available: response.available,
        issued: response.issued,
        endpoint: response.endpoint,
        personalTokenPreview: response.personalTokenPreview,
        userName: response.userName,
        version: 1,
        algorithm: 'RSA-OAEP-256+A256GCM',
        requestNonce,
        encryptedKey: encryptedKey.toString('base64url'),
        iv: iv.toString('base64url'),
        ciphertext: encryptedPayload.toString('base64url'),
      };
    } finally {
      contentKey.fill(0);
      plaintext.fill(0);
    }
  }

  private encryptionContext(requestNonce: string): Buffer {
    return Buffer.from(`mcp-credential-v1\u0000${requestNonce}`, 'utf8');
  }

  private parseRequestNonce(value: string): string {
    const requestNonce: string = value?.trim() || '';
    if (!REQUEST_NONCE_PATTERN.test(requestNonce)) {
      throw new BadRequestException('MCP 请求随机数无效');
    }
    return requestNonce;
  }

  private parseEncryptionKey(value: string): KeyObject {
    const encodedPublicKey: string = value?.trim() || '';
    if (
      !encodedPublicKey ||
      encodedPublicKey.length > MAXIMUM_PUBLIC_KEY_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(encodedPublicKey)
    ) {
      throw new BadRequestException('MCP 临时公钥无效');
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({
        key: Buffer.from(encodedPublicKey, 'base64url'),
        format: 'der',
        type: 'spki',
      });
    } catch {
      throw new BadRequestException('MCP 临时公钥无效');
    }
    const modulusLength: number =
      publicKey.asymmetricKeyDetails?.modulusLength || 0;
    if (
      publicKey.asymmetricKeyType !== 'rsa' ||
      modulusLength < 2048 ||
      modulusLength > 4096
    ) {
      throw new BadRequestException('MCP 临时公钥强度不符合要求');
    }
    return publicKey;
  }

  private sign(
    record: McpCredentialRecord,
    currentUser: CurrentUserSummary,
    mcpConfiguration: McpConfiguration = configuration(),
  ): string {
    const payload: McpTokenPayload = {
      version: 1,
      audience: mcpConfiguration.audience,
      credentialId: record.id,
      tokenVersion: record.tokenVersion,
      miaodaUserId: currentUser.miaodaUserId,
      employeeId: currentUser.employeeId,
      openId: currentUser.openId,
      name: currentUser.name,
      roles: (currentUser.roles || []).filter((role: string): boolean =>
        MCP_ROLES.has(role),
      ),
    };
    const encodedPayload: string = Buffer.from(
      JSON.stringify(payload),
      'utf8',
    ).toString('base64url');
    const signature: string = this.signature(
      encodedPayload,
      mcpConfiguration.personalTokenSecret,
    );
    return `${TOKEN_PREFIX}.${encodedPayload}.${signature}`;
  }

  private parse(personalToken: string): McpTokenPayload {
    const token: string = personalToken.trim();
    const parts: string[] = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
      throw new UnauthorizedException('个人 MCP Key 无效');
    }
    const encodedPayload: string = parts[1];
    const suppliedSignature: string = parts[2];
    const mcpConfiguration: McpConfiguration = configuration();
    const expectedSignature: string = this.signature(
      encodedPayload,
      mcpConfiguration.personalTokenSecret,
    );
    const suppliedBuffer: Buffer = Buffer.from(suppliedSignature);
    const expectedBuffer: Buffer = Buffer.from(expectedSignature);
    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('个人 MCP Key 无效');
    }

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      );
    } catch {
      throw new UnauthorizedException('个人 MCP Key 无效');
    }
    if (!rawPayload || typeof rawPayload !== 'object') {
      throw new UnauthorizedException('个人 MCP Key 无效');
    }
    const payload: Record<string, unknown> = rawPayload as Record<
      string,
      unknown
    >;
    if (
      payload.version !== 1 ||
      payload.audience !== mcpConfiguration.audience ||
      !Number.isInteger(payload.tokenVersion) ||
      Number(payload.tokenVersion) < 1
    ) {
      throw new UnauthorizedException('个人 MCP Key 无效');
    }
    const roles: string[] = Array.isArray(payload.roles)
      ? payload.roles.filter(
          (role: unknown): role is string =>
            typeof role === 'string' && MCP_ROLES.has(role),
        )
      : [];
    if (
      Array.isArray(payload.roles) &&
      roles.length !== payload.roles.length
    ) {
      throw new UnauthorizedException('个人 MCP Key 无效');
    }
    return {
      version: 1,
      audience: validString(payload.audience),
      credentialId: validString(payload.credentialId),
      tokenVersion: Number(payload.tokenVersion),
      miaodaUserId: validString(payload.miaodaUserId),
      employeeId: validString(payload.employeeId),
      openId: validString(payload.openId),
      name: validString(payload.name),
      roles,
    };
  }

  private subjectHash(
    miaodaUserId: string,
    mcpConfiguration: McpConfiguration = configuration(),
  ): string {
    return createHmac('sha256', mcpConfiguration.personalTokenSecret)
      .update(
        `mcp-subject\u0000${mcpConfiguration.audience}\u0000${miaodaUserId}`,
      )
      .digest('hex');
  }

  private signature(encodedPayload: string, secret: string): string {
    return createHmac('sha256', secret)
      .update(encodedPayload)
      .digest('base64url');
  }

  private preview(token: string): string {
    return `****${token.slice(-4)}`;
  }

  private ensureUserCanUseMcp(currentUser: CurrentUserSummary): void {
    if (
      !currentUser.miaodaUserId ||
      !currentUser.employeeId ||
      !currentUser.openId ||
      !currentUser.name
    ) {
      throw new UnauthorizedException(
        '当前账号未完整关联飞书身份，无法使用 MCP',
      );
    }
  }
}
