import {
  canonicalOrigin,
  validRedirect,
  redirectMatches,
  parseScopes,
  hasScope,
  assertBrowserOrigin,
} from './knowledge-policy';
import {
  OPERATIONS,
  nativeRoutePolicy,
  catalogForClient,
} from './knowledge-catalog';
describe('knowledge OAuth and operation boundary', () => {
  test('reviewed WorkBuddy callback is accepted only as an exact registered URI',()=>{expect(validRedirect('workbuddy://oauth/callback')).toBe(true);expect(redirectMatches('workbuddy://oauth/callback','workbuddy://oauth/callback')).toBe(true);});
  test('unreviewed native schemes and WorkBuddy callback variations remain blocked',()=>{for(const u of ['workbuddy://evil/callback','workbuddy://oauth/callback?extra=1','otheragent://oauth/callback'])expect(validRedirect(u)).toBe(false);});
  test.each([
    'http://evil.example/cb',
    'https://example.com/cb#fragment',
    'https://user:password@example.com/cb',
    'javascript:alert(1)',
    'https://example.com/\\callback',
    'https://example.com/\ncallback',
  ])('unsafe callback rejected %s', (uri) =>
    expect(validRedirect(uri)).toBe(false),
  );
  test.each([
    'https://chatgpt.com/connector_platform/oauth/callback',
    'http://localhost:1023/cb',
    'http://127.0.0.1:9999/cb',
    'http://[::1]:1234/cb',
  ])('valid public client callback %s', (uri) =>
    expect(validRedirect(uri)).toBe(true),
  );
  test('only loopback ports may vary, not path or host', () => {
    expect(
      redirectMatches('http://127.0.0.1:2345/cb', 'http://127.0.0.1:9987/cb'),
    ).toBe(true);
    expect(
      redirectMatches('http://localhost:2345/cb', 'http://127.0.0.1:9987/cb'),
    ).toBe(false);
    expect(
      redirectMatches(
        'http://127.0.0.1:2345/other',
        'http://127.0.0.1:9987/cb',
      ),
    ).toBe(false);
    expect(
      redirectMatches(
        'https://example.com:123/cb',
        'https://example.com:456/cb',
      ),
    ).toBe(false);
  });
  test('scope hierarchy does not turn read into write or mail into document access', () => {
    expect(hasScope(['knowledge:write'], 'knowledge:read')).toBe(true);
    expect(hasScope(['knowledge:read'], 'knowledge:write')).toBe(false);
    expect(hasScope(['knowledge:manage'], 'knowledge:write')).toBe(false);
    expect(hasScope(['knowledge:mail'], 'knowledge:read')).toBe(false);
  });
  test('unknown scopes and untrusted browser origins are rejected', () => {
    expect(() => parseScopes('knowledge:read admin')).toThrow();
    expect(() =>
      assertBrowserOrigin('https://evil.example', 'https://kb.example'),
    ).toThrow();
    expect(() => canonicalOrigin('http://0.0.0.0:5840')).toThrow();
  });
  test('native routes expose neither user nor auth nor raw page update endpoints', () => {
    for (const path of [
      '/api/auth/login',
      '/api/users/update',
      '/api/pages/update',
      '/api/workspace/update',
      '/api/files/avatar',
    ])
      expect(nativeRoutePolicy('POST', path, {})).toBeUndefined();
    expect(
      nativeRoutePolicy('POST', '/api/pages/delete', {
        permanentlyDelete: true,
      }),
    ).toBe('knowledge:manage');
  });
  test('all write operations require request IDs and reject undeclared fields', () => {
    for (const op of OPERATIONS) {
      expect(
        op.schema.safeParse({
          userId: 'fake',
          workspaceId: 'fake',
          accessToken: 'fake',
        }).success,
      ).toBe(false);
      if (op.mutates)
        expect(
          catalogForClient().find((c) => c.name === op.name).inputSchema
            .required,
        ).toContain('requestId');
    }
    expect(new Set(OPERATIONS.map((v) => v.name)).size).toBe(OPERATIONS.length);
  });
  test('catalog does not advertise an unavailable licensed space setting', () => {
    expect(OPERATIONS.find(o => o.name === 'kb_space_update').schema.safeParse({spaceId:'00000000-0000-4000-8000-000000000001',requestId:'00000000-0000-4000-8000-000000000002',disablePublicSharing:true}).success).toBe(false);
    expect(catalogForClient().find(o => o.name === 'kb_space_update').inputSchema.properties).not.toHaveProperty('disablePublicSharing');
  });

});
