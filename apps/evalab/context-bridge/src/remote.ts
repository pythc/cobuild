import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { BridgeConfig } from './config.js';
import { diag, safeErrorText } from './diag.js';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_CHUNK_BYTES } from './limits.js';
import type { MaterialClient } from './types.js';
import { BRIDGE_VERSION } from './version.js';
import type { UploadTicket } from './directUpload.js';

export type RemoteInvoker = (
  config: BridgeConfig,
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

let invoker: RemoteInvoker = invokeRemoteHttp;

/** Test seam. Production always uses the HTTP invoker. */
export function setRemoteInvokerForTests(next: RemoteInvoker | null): void {
  invoker = next ?? invokeRemoteHttp;
}

export function callRemote(config: BridgeConfig, name: string, args: Record<string, unknown>): Promise<unknown> {
  return invoker(config, name, args);
}

const ticketSchema = z.object({
  uploadId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  uploadUrl: z.string().url(),
  uploadToken: z.string().regex(/^lu_[A-Za-z0-9_-]{43}$/),
  expiresAt: z.string().min(4).max(80),
  maxTotalBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  chunkBytes: z.number().int().positive().max(MAX_UPLOAD_CHUNK_BYTES),
  helperUrl: z.string().min(1).max(500).optional(),
  status: z.literal('AWAITING_FILES'),
}).strip();

export async function requestUploadTicket(
  config: BridgeConfig,
  args: {
    repoSha: string;
    clients: MaterialClient[];
    projectSummary: string;
    collaborationSummary: string;
  },
): Promise<UploadTicket> {
  const value = await callRemote(config, 'submit_materials', {
    repoSha: args.repoSha,
    clients: args.clients,
    projectSummary: args.projectSummary,
    collaborationSummary: args.collaborationSummary,
  });
  const parsed = ticketSchema.safeParse(value);
  if (!parsed.success) throw new Error('exam server returned an unreadable upload ticket');
  return {
    uploadId: parsed.data.uploadId,
    uploadUrl: parsed.data.uploadUrl,
    uploadToken: parsed.data.uploadToken,
    maxTotalBytes: parsed.data.maxTotalBytes,
    chunkBytes: parsed.data.chunkBytes,
  };
}

async function invokeRemoteHttp(config: BridgeConfig, name: string, args: Record<string, unknown>): Promise<unknown> {
  const endpoint = new URL(config.mcpPath.replace(/^\//, ''), `${config.assessmentUrl}/`);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(60_000),
    },
  });
  transport.onerror = () => {
    diag('remote transport error');
  };
  const client = new Client({ name: 'assessment-context-bridge', version: BRIDGE_VERSION });
  client.onerror = () => {
    diag('remote mcp call failed');
  };
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    return readToolResult(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('exam server')) throw error;
    diag('remote mcp call failed');
    throw new Error(safeErrorText(error, 'exam server request failed'));
  } finally {
    await client.close().catch(() => undefined);
  }
}

function readToolResult(result: unknown): unknown {
  const value = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = value.content?.find((item) => item.type === 'text')?.text;
  if (value.isError) throw new Error(safeErrorText(new Error(text ?? ''), 'exam server rejected the call'));
  if (value.structuredContent && typeof value.structuredContent === 'object') return value.structuredContent;
  if (!text) throw new Error('exam server returned an empty tool result');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('exam server returned an unreadable tool result');
  }
}
