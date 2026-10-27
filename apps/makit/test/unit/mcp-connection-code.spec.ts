import { decode } from 'js-base64';
import type { McpCredentialResponse } from '../../shared/api.interface';
import {
  MCP_CONNECTION_CODE_PREFIX,
  createMcpConnectionCode,
} from '../../client/src/lib/mcp-connection-code';

describe('MCP connection code', () => {
  it('packs the endpoint and both credentials into one URL-safe code', () => {
    const credential: McpCredentialResponse = {
      available: true,
      issued: true,
      endpoint: 'https://requirements.example.com/openapi/mcp',
      openApiKey: 'openapi-test-key',
      personalToken: 'rmcp_v1.test.signature',
      personalTokenPreview: '****test',
      userName: '测试用户',
    };

    const code: string = createMcpConnectionCode(credential);
    expect(code.startsWith(MCP_CONNECTION_CODE_PREFIX)).toBe(true);
    expect(code).not.toContain('+');
    expect(code).not.toContain('/');

    const encoded: string = code.slice(MCP_CONNECTION_CODE_PREFIX.length);
    expect(JSON.parse(decode(encoded))).toEqual({
      version: 1,
      endpoint: credential.endpoint,
      openApiKey: credential.openApiKey,
      personalToken: credential.personalToken,
    });
  });
});
