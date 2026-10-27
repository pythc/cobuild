import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject,
} from 'node:crypto';
import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import type {
  CurrentUserSummary,
  McpCredentialResponse,
  McpEncryptedCredentialResponse,
} from '@shared/api.interface';
import { createMcpCredentialExchange } from '../../client/src/lib/mcp-credential-crypto';
import { McpPersonalTokenService } from '../../server/modules/requirements/mcp-personal-token.service';
import { RequirementAccessService } from '../../server/modules/requirements/requirement-access.service';
import type { RequirementPlatformRoleService } from '../../server/modules/requirements/requirement-platform-role.service';
import type { ServiceRoleDatabaseExecutor } from '../../server/database/service-role-database.executor';

const TEST_USER: CurrentUserSummary = {
  miaodaUserId: '687684000000000001',
  employeeId: '687684000000000002',
  openId: 'ou_test_user',
  name: '测试用户',
  roles: ['editor'],
};

const TEST_SECRET = 'unit-test-personal-token-secret-with-enough-entropy';
const TEST_AUDIENCE = 'requirements-test';
const TEST_REQUEST_NONCE = 'MDEyMzQ1Njc4OWFiY2RlZg';
const ACTIVE_RECORD = {
  credential_id: 'a7f8977a-d723-4a28-a9b6-65827851ad0c',
  token_version: 1,
  revoked_at: null,
};

function database(responses: unknown[][] = []): PostgresJsDatabase {
  const queued: unknown[][] = [...responses];
  const execute = jest
    .fn()
    .mockImplementation(async () => queued.shift() || [ACTIVE_RECORD]);
  return { execute } as unknown as PostgresJsDatabase;
}

function tokenService(
  responses: unknown[][] = [],
  currentRoles: string[] = ['editor'],
): McpPersonalTokenService {
  const db: PostgresJsDatabase = database(responses);
  const platformRoles = {
    currentRoles: jest.fn().mockResolvedValue(currentRoles),
  };
  const serviceRoleDatabase = {
    run: jest.fn(
      async <T>(operation: (database: PostgresJsDatabase) => Promise<T>) =>
        operation(db),
    ),
  };
  return new McpPersonalTokenService(
    db,
    platformRoles as unknown as RequirementPlatformRoleService,
    new RequirementAccessService(),
    serviceRoleDatabase as unknown as ServiceRoleDatabaseExecutor,
  );
}

function encryptionKeys(modulusLength: number = 2048): {
  privateKey: KeyObject;
  publicKey: string;
} {
  const pair = generateKeyPairSync('rsa', {
    modulusLength,
    publicExponent: 0x10001,
  });
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url'),
  };
}

function decryptCredential(
  encrypted: McpEncryptedCredentialResponse,
  privateKey: KeyObject,
): McpCredentialResponse {
  const contentKey: Buffer = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(encrypted.encryptedKey, 'base64url'),
  );
  const encryptedPayload: Buffer = Buffer.from(
    encrypted.ciphertext,
    'base64url',
  );
  const authenticationTag: Buffer = encryptedPayload.subarray(-16);
  const ciphertext: Buffer = encryptedPayload.subarray(0, -16);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    contentKey,
    Buffer.from(encrypted.iv, 'base64url'),
  );
  decipher.setAAD(
    Buffer.from(`mcp-credential-v1\u0000${encrypted.requestNonce}`, 'utf8'),
  );
  decipher.setAuthTag(authenticationTag);
  return JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    ),
  ) as McpCredentialResponse;
}

describe('McpPersonalTokenService', () => {
  const originalEnvironment: NodeJS.ProcessEnv = { ...process.env };

  beforeEach((): void => {
    process.env.MCP_PERSONAL_TOKEN_SECRET = TEST_SECRET;
    process.env.MCP_TRANSPORT_API_KEY = 'unit-test-transport-key';
    process.env.MCP_TOKEN_AUDIENCE = TEST_AUDIENCE;
    process.env.MCP_PUBLIC_ENDPOINT = 'https://requirements.test/openapi/mcp';
    process.env.MIAODA_APP_ID = 'test-app';
  });

  afterAll((): void => {
    process.env = originalEnvironment;
  });

  it('issues one stable personal token for the same credential version', async () => {
    const service = tokenService([[ACTIVE_RECORD], [ACTIVE_RECORD]]);

    const first = await service.issue(TEST_USER);
    const second = await service.issue(TEST_USER);

    expect(first.personalToken).toBe(second.personalToken);
    expect(first.personalToken).toMatch(/^rmcp_v1[.]/u);
    expect(first.openApiKey).toBe('unit-test-transport-key');
    expect(first.personalTokenPreview).toHaveLength(8);
  });

  it('only returns encrypted credentials to the browser transport', async () => {
    const service = tokenService([[ACTIVE_RECORD]]);
    const keys = encryptionKeys();

    const encrypted = await service.issueEncrypted(
      TEST_USER,
      keys.publicKey,
      TEST_REQUEST_NONCE,
    );
    const serialized: string = JSON.stringify(encrypted);

    expect(encrypted.algorithm).toBe('RSA-OAEP-256+A256GCM');
    expect(serialized).not.toContain('unit-test-transport-key');
    expect(serialized).not.toContain('rmcp_v1');
    expect(decryptCredential(encrypted, keys.privateKey)).toEqual(
      expect.objectContaining({
        openApiKey: 'unit-test-transport-key',
        personalToken: expect.stringMatching(/^rmcp_v1[.]/u),
      }),
    );
  });

  it('round-trips through browser WebCrypto and rejects tampered ciphertext', async () => {
    const service = tokenService([[ACTIVE_RECORD], [ACTIVE_RECORD]]);
    const exchange = await createMcpCredentialExchange();
    const encrypted = await service.issueEncrypted(
      TEST_USER,
      exchange.input.publicKey,
      exchange.input.requestNonce,
    );

    await expect(exchange.decrypt(encrypted)).resolves.toEqual(
      expect.objectContaining({
        openApiKey: 'unit-test-transport-key',
        personalToken: expect.stringMatching(/^rmcp_v1[.]/u),
      }),
    );

    const tamperedCiphertext: Buffer = Buffer.from(
      encrypted.ciphertext,
      'base64url',
    );
    tamperedCiphertext[0] ^= 1;
    await expect(
      exchange.decrypt({
        ...encrypted,
        ciphertext: tamperedCiphertext.toString('base64url'),
      }),
    ).rejects.toThrow('MCP Key 解密失败');
  });

  it('rejects weak browser encryption keys', async () => {
    const service = tokenService([[ACTIVE_RECORD]]);
    const keys = encryptionKeys(1024);

    await expect(
      service.issueEncrypted(TEST_USER, keys.publicKey, TEST_REQUEST_NONCE),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('restores the current stored user identity', async () => {
    const service = tokenService([[ACTIVE_RECORD], [{ valid: true }]]);
    const credential = await service.issue(TEST_USER);

    await expect(service.verify(credential.personalToken)).resolves.toEqual({
      ...TEST_USER,
      platformAppId: 'test-app',
      roles: ['editor'],
      platformRoleIds: ['editor'],
      accessLevel: 'editor',
      capabilities: {
        canCreate: true,
        canViewArchive: true,
        canPermanentlyDelete: true,
        canViewNotifications: true,
        canViewOperations: false,
        canManageOperationsAdmins: false,
      },
      mcpWriteProof: {
        credentialId: ACTIVE_RECORD.credential_id,
        tokenVersion: ACTIVE_RECORD.token_version,
        subjectHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
  });

  it('keeps the real viewer role while allowing authenticated business access', async () => {
    const service = tokenService(
      [[ACTIVE_RECORD], [{ valid: true }]],
      ['viewer'],
    );
    const viewer: CurrentUserSummary = { ...TEST_USER, roles: ['viewer'] };
    const credential = await service.issue(viewer);

    await expect(service.verify(credential.personalToken)).resolves.toEqual({
      ...viewer,
      platformAppId: 'test-app',
      roles: ['viewer'],
      platformRoleIds: ['viewer'],
      accessLevel: 'viewer',
      capabilities: {
        canCreate: true,
        canViewArchive: true,
        canPermanentlyDelete: true,
        canViewNotifications: true,
        canViewOperations: false,
        canManageOperationsAdmins: false,
      },
      mcpWriteProof: {
        credentialId: ACTIVE_RECORD.credential_id,
        tokenVersion: ACTIVE_RECORD.token_version,
        subjectHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
  });

  it('downgrades an old editor token when the live platform role changed', async () => {
    const service = tokenService(
      [[ACTIVE_RECORD], [{ valid: true }]],
      ['viewer'],
    );
    const credential = await service.issue(TEST_USER);

    await expect(service.verify(credential.personalToken)).resolves.toEqual(
      expect.objectContaining({
        roles: ['viewer'],
        platformRoleIds: ['viewer'],
        accessLevel: 'viewer',
      }),
    );
  });

  it('rejects a tampered token before reading the credential record', async () => {
    const service = tokenService();
    const credential = await service.issue(TEST_USER);
    const tampered: string = `${credential.personalToken.slice(0, -1)}x`;

    await expect(service.verify(tampered)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token issued for another environment audience', async () => {
    const service = tokenService();
    const credential = await service.issue(TEST_USER);
    process.env.MCP_TOKEN_AUDIENCE = 'requirements-production';

    await expect(
      service.verify(credential.personalToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('invalidates the old token after a per-user rotation', async () => {
    const rotatedRecord = { ...ACTIVE_RECORD, token_version: 2 };
    const service = tokenService([
      [ACTIVE_RECORD],
      [rotatedRecord],
      [{ valid: false }],
      [{ valid: true }],
    ]);
    const oldCredential = await service.issue(TEST_USER);
    const newCredential = await service.rotate(TEST_USER);

    expect(newCredential.personalToken).not.toBe(oldCredential.personalToken);
    await expect(
      service.verify(oldCredential.personalToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.verify(newCredential.personalToken)).resolves.toEqual({
      ...TEST_USER,
      platformAppId: 'test-app',
      roles: ['editor'],
      platformRoleIds: ['editor'],
      accessLevel: 'editor',
      capabilities: {
        canCreate: true,
        canViewArchive: true,
        canPermanentlyDelete: true,
        canViewNotifications: true,
        canViewOperations: false,
        canManageOperationsAdmins: false,
      },
      mcpWriteProof: {
        credentialId: rotatedRecord.credential_id,
        tokenVersion: rotatedRecord.token_version,
        subjectHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
  });

  it('rejects users without a complete Feishu identity', async () => {
    const service = tokenService();

    await expect(
      service.issue({ ...TEST_USER, openId: '' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a weak signing secret', async () => {
    process.env.MCP_PERSONAL_TOKEN_SECRET = 'too-short';
    const service = tokenService();

    await expect(service.issue(TEST_USER)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports unavailable when environment setup is incomplete', async () => {
    delete process.env.MCP_TRANSPORT_API_KEY;
    const service = tokenService([[ACTIVE_RECORD]]);

    await expect(service.status(TEST_USER)).resolves.toEqual(
      expect.objectContaining({ available: false, issued: false }),
    );
    await expect(service.issue(TEST_USER)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
