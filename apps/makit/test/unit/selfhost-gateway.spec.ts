import { gatewayAllowed } from '../../server/common/selfhost/gateway';
describe('intranet HTTPS forwarding boundary', () => {
  const environment = { ...process.env };
  afterEach(() => { process.env = { ...environment }; });
  it('keeps only read-only health probes public and requires the independent key on business routes', () => {
    process.env.MAKIT_REQUIRE_GATEWAY = 'true'; process.env.MAKIT_GATEWAY_KEY = 'g'.repeat(43);
    const request = { method: 'GET', path: '/readyz', headers: {} };
    expect(gatewayAllowed(request)).toBe(true);
    expect(gatewayAllowed({ ...request, method: 'POST' })).toBe(false);
    expect(gatewayAllowed({ ...request, path: '/openapi/mcp' })).toBe(false);
    expect(gatewayAllowed({ ...request, path: '/', headers: { 'x-makit-gateway-key': 'g'.repeat(43) } })).toBe(true);
    expect(gatewayAllowed({ ...request, path: '/', headers: { 'x-makit-gateway-key': ['g'.repeat(43)] } })).toBe(false);
    delete process.env.MAKIT_GATEWAY_KEY;
    expect(gatewayAllowed({ ...request, path: '/' })).toBe(false);
  });
});
