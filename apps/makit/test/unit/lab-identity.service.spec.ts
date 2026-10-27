import { LabIdentityService } from '../../server/modules/requirements/lab-identity.service';
describe('unified requirements identity', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });
  function create() {
    process.env.LAB_IDENTITY_ENABLED = 'true';
    process.env.LAB_IDENTITY_TENANT_KEY = 'tenant';
    process.env.REQUIREMENT_PLATFORM_APP_ID = 'app_fixture';
    const feishu = {
        getUserByUnionId: jest.fn(async () => ({
          employeeId: 'employee',
          openId: 'ou_fixture',
          name: '虚构成员',
        })),
      },
      authn = {
        getBatchMiaodaUserIds: jest.fn(async () => ['miaoda-member']),
        getBatchLarkUserIds: jest.fn(async () => ['employee']),
      },
      context = { run: jest.fn(async (_: any, fn: () => any) => fn()) },
      roles = { currentRoles: jest.fn(async () => ['viewer']) },
      access = { decorate: (u: any) => u },
      tokens = {
        issueEncrypted: jest.fn(async () => ({ version: 1 })),
        issueForLabIdentity: jest.fn(async () => ({ issued: true })),
        verify: jest.fn(async () => ({
          miaodaUserId: 'miaoda-member',
          employeeId: 'employee',
          mcpWriteProof: { credentialId: 'id' },
        })),
      };
    const service = new LabIdentityService(
      feishu as any,
      authn as any,
      context as any,
      roles as any,
      access as any,
      tokens as any,
    );
    return { service, feishu, authn, roles, tokens };
  }
  const response = () => ({
    issuer: 'https://internal.110-lab.cn',
    audience: 'requirements',
    tenantKey: 'tenant',
    unionId: 'on_fictional00000001',
    subject: 'tenant:on_fictional00000001',
    role: 'super_admin',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  function mock(p: any) {
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(p)));
  }
  test('maps both directions and uses actual platform roles, never a portal administrator claim', async () => {
    const f = create();
    mock(response());
    const actor = await f.service.actor('x'.repeat(43));
    expect(actor.platformRoleIds).toEqual(['viewer']);
    expect(f.authn.getBatchMiaodaUserIds).toHaveBeenCalledWith(['employee']);
    expect(f.authn.getBatchLarkUserIds).toHaveBeenCalledWith(['miaoda-member']);
    expect(((await f.service.connect('x'.repeat(43))) as any).issued).toBe(
      true,
    );
  });
  test('rejects mismatched reverse identity before credential issuance', async () => {
    const f = create();
    mock(response());
    f.authn.getBatchLarkUserIds.mockResolvedValue(['other-employee']);
    await expect(f.service.connect('x'.repeat(43))).rejects.toThrow(
      '平台身份不一致',
    );
    expect(f.tokens.issueForLabIdentity).not.toHaveBeenCalled();
  });
  test('requires the personal write proof to belong to the same validated actor', async () => {
    const f = create();
    mock(response());
    f.tokens.verify.mockResolvedValue({
      miaodaUserId: 'other-member',
      employeeId: 'employee',
      mcpWriteProof: { credentialId: 'id' },
    });
    await expect(f.service.verify('x'.repeat(43), 'token')).rejects.toThrow(
      '同一个实验室账号',
    );
  });
  test.each([
    { issuer: 'https://other.example' },
    { audience: 'knowledge' },
    { tenantKey: 'other' },
    { subject: 'tenant:other' },
    { expiresAt: 'invalid' },
    { expiresAt: new Date(0).toISOString() },
  ])('rejects a wrong identity %p', async (patch) => {
    const f = create();
    mock({ ...response(), ...patch });
    await expect(f.service.actor('x'.repeat(43))).rejects.toThrow();
    expect(f.feishu.getUserByUnionId).not.toHaveBeenCalled();
  });
  test('missing, expired, revoked or unavailable login never falls back to the native token', async () => {
    const f = create();
    await expect(f.service.actor('')).rejects.toThrow();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 401 }));
    await expect(f.service.actor('x'.repeat(43))).rejects.toThrow(
      '统一登录已失效',
    );
    (fetch as jest.Mock).mockRejectedValue(new Error());
    await expect(f.service.actor('x'.repeat(43))).rejects.toThrow(
      '暂时无法核对统一身份',
    );
  });
  test('native first consent never issues a key for a different current user', async () => {
    const f = create();
    mock(response());
    const { sealTicket } = await import('../../server/modules/requirements/lab-identity-ticket');
    const { generateKeyPairSync } = await import('node:crypto');
    const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.MCP_PERSONAL_TOKEN_SECRET =
      'fictional-ticket-test-private-key-2026';
    const ticket = sealTicket({
      token: 'x'.repeat(43),
      publicKey: k.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64url'),
      requestNonce: 'n'.repeat(22),
      state: 's'.repeat(43),
      redirectUri: 'http://127.0.0.1:9876/callback/110lab_requirements',
    });
    await expect(
      f.service.confirm(ticket, {
        employeeId: 'other',
        miaodaUserId: 'other',
      } as any),
    ).rejects.toThrow('同一飞书账号');
    expect(f.tokens.issueEncrypted).not.toHaveBeenCalled();
    await expect(
      f.service.confirm(ticket, {
        employeeId: 'employee',
        miaodaUserId: 'miaoda-member',
      } as any),
    ).resolves.toMatchObject({ state: 's'.repeat(43) });
    expect(f.tokens.issueEncrypted).toHaveBeenCalledTimes(1);
  });
});
