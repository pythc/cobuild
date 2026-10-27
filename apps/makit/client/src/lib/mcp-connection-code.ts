import { encode } from 'js-base64';
import type { McpCredentialResponse } from '@shared/api.interface';

const MCP_CONNECTION_CODE_PREFIX: string = 'rmcpc_v1.';

interface McpConnectionCodePayload {
  version: 1;
  endpoint: string;
  openApiKey: string;
  personalToken: string;
}

function createMcpConnectionCode(credential: McpCredentialResponse): string {
  const payload: McpConnectionCodePayload = {
    version: 1,
    endpoint: credential.endpoint,
    openApiKey: credential.openApiKey,
    personalToken: credential.personalToken,
  };
  return `${MCP_CONNECTION_CODE_PREFIX}${encode(JSON.stringify(payload), true)}`;
}

export { MCP_CONNECTION_CODE_PREFIX, createMcpConnectionCode };
