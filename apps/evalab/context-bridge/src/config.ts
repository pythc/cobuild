import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeRoot } from './scope.js';

export type BridgeConfig = {
  assessmentUrl: string;
  token: string;
  workspaceReal: string;
  contextRoots: string[];
  mcpPath: string;
};

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<BridgeConfig> {
  const assessmentUrl = parseAssessmentUrl(required(env.ASSESSMENT_URL, 'ASSESSMENT_URL is required'));
  const token = parseToken(required(env.ASSESSMENT_MCP_TOKEN, 'ASSESSMENT_MCP_TOKEN is required'));
  const workspaceReal = await parseRoot(required(env.ASSESSMENT_WORKSPACE, 'ASSESSMENT_WORKSPACE is required'));
  const extra = await parseRoots(env.ASSESSMENT_CONTEXT_ROOTS);
  const contextRoots = dedupe([workspaceReal, ...extra]);
  const mcpPath = parseMcpPath(env.ASSESSMENT_MCP_PATH);
  return {
    assessmentUrl: assessmentUrl.origin,
    token,
    workspaceReal,
    contextRoots,
    mcpPath,
  };
}

function required(value: string | undefined, message: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function parseAssessmentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ASSESSMENT_URL must be https, or http on loopback, without credentials, a path, or a query');
  }
  if (url.username || url.password) throw new Error('ASSESSMENT_URL must not include credentials');
  if (url.search || url.hash) throw new Error('ASSESSMENT_URL must not include a query or hash');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('ASSESSMENT_URL must not include a path');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return url;
  throw new Error('ASSESSMENT_URL must use https except for loopback http');
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parseToken(value: string): string {
  if (value.length < 20 || value.length > 200 || /\s/.test(value)) {
    throw new Error('ASSESSMENT_MCP_TOKEN is invalid');
  }
  return value;
}

function parseMcpPath(value: string | undefined): string {
  const pathName = value?.trim() || '/mcp';
  if (!pathName.startsWith('/') || pathName.includes('..') || pathName.includes('\\') || pathName.includes('?')) {
    throw new Error('ASSESSMENT_MCP_PATH is invalid');
  }
  return pathName;
}

export function splitContextRoots(value: string, delimiter = path.delimiter): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('ASSESSMENT_CONTEXT_ROOTS JSON is invalid');
    }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('ASSESSMENT_CONTEXT_ROOTS must be a JSON array of absolute paths');
    }
    return parsed.map((item) => item.trim()).filter((item) => item.length > 0);
  }
  return trimmed
    .split(/\r?\n/)
    .flatMap((line) => line.split(delimiter))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function parseRoots(value: string | undefined): Promise<string[]> {
  if (!value?.trim()) return [];
  const parts = splitContextRoots(value);
  const roots: string[] = [];
  for (const part of parts) roots.push(await parseRoot(part));
  return roots;
}

async function parseRoot(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error('A context root must be an absolute directory');
  let info;
  try {
    info = await lstat(value);
  } catch {
    throw new Error('A context root is not a directory');
  }
  if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error('A context root is not a directory');
  let real: string;
  try {
    real = await realpath(value);
  } catch {
    throw new Error('A context root is not a directory');
  }
  const realInfo = await lstat(real);
  if (!realInfo.isDirectory()) throw new Error('A context root is not a directory');
  assertSafeRoot(real);
  return real;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
