import { realpathSync } from 'node:fs';
import path from 'node:path';
import { HEAD_BYTES, MAX_FILE_BYTES } from './limits.js';
import { forEachLine, readHead } from './lines.js';

export type CodexInspection = {
  cwd: string | null;
  cliVersion?: string;
  provider?: string;
  model?: string;
};

export type TranscriptTurn = { role: 'user' | 'assistant'; text: string };

export type CodexTranscript = {
  turns: TranscriptTurn[];
  truncated: boolean;
  cliVersion?: string;
  provider?: string;
  model?: string;
  workspaceMatched: boolean;
};

export function inspectCodexHead(head: string): CodexInspection | null {
  const window = head.slice(0, HEAD_BYTES);
  if (!/"type"\s*:\s*"session_meta"/.test(window)) return null;
  const end = window.indexOf('"base_instructions"');
  const meta = end === -1 ? window : window.slice(0, end);
  return {
    cwd: jsonStringField(meta, 'cwd'),
    cliVersion: jsonStringField(meta, 'cli_version') ?? undefined,
    provider: jsonStringField(meta, 'model_provider') ?? undefined,
    model: jsonStringField(window, 'model') ?? undefined,
  };
}

export function workspaceMatches(sessionCwd: string | null, workspaceReal: string): boolean {
  if (!sessionCwd) return false;
  let resolved = path.resolve(sessionCwd);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // The recorded cwd may not exist on this machine. Compare the resolved path.
  }
  if (resolved === workspaceReal) return true;
  const prefix = workspaceReal.endsWith(path.sep) ? workspaceReal : workspaceReal + path.sep;
  return resolved.startsWith(prefix);
}

export async function readCodexTranscript(file: string, workspaceReal: string): Promise<CodexTranscript> {
  const head = await readHead(file, HEAD_BYTES);
  const inspected = inspectCodexHead(head);
  if (!inspected) throw new Error('File is not a Codex session JSONL export');
  const turns: TranscriptTurn[] = [];
  let bytes = 0;
  let truncated = false;
  let model = inspected.model;
  await forEachLine(file, (line) => {
    if (!line.trim()) return;
    const envelope = envelopeType(line);
    if (envelope === 'session_meta') return;
    if (envelope === 'turn_context' && !model) {
      model = jsonStringField(line, 'model') ?? undefined;
      return;
    }
    if (envelope !== 'response_item') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const payload = (parsed as { payload?: unknown }).payload;
    if (payload && typeof payload === 'object' && (payload as { type?: string }).type === 'message') {
      const message = payload as { role?: string; channel?: unknown; phase?: unknown; content?: unknown };
      const role = visibleRole(message.role, message.channel ?? message.phase);
      if (!role) return;
      for (const text of collectText(message.content)) {
        const clean = text.trim();
        if (!clean) continue;
        const next = Buffer.byteLength(clean, 'utf8') + 16;
        if (bytes + next > MAX_FILE_BYTES) {
          truncated = true;
          return 'stop';
        }
        bytes += next;
        turns.push({ role, text: clean });
      }
    }
  });
  if (turns.length === 0) {
    throw new Error('Codex session has no role-filtered user or assistant text');
  }
  return {
    turns,
    truncated,
    cliVersion: inspected.cliVersion,
    provider: inspected.provider,
    model,
    workspaceMatched: workspaceMatches(inspected.cwd, workspaceReal),
  };
}

function envelopeType(line: string): string | null {
  const match = /"type"\s*:\s*"([^"]+)"/.exec(line.slice(0, 500));
  return match?.[1] ?? null;
}

function jsonStringField(source: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(source);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

const HIDDEN_CHANNELS = new Set(['analysis', 'reasoning', 'hidden', 'internal']);

function visibleRole(role: string | undefined, channel: unknown): 'user' | 'assistant' | null {
  const name = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
  if (HIDDEN_CHANNELS.has(name)) return null;
  if (role === 'user') return 'user';
  if (role !== 'assistant') return null;
  if (name === '' || name === 'final' || name === 'commentary') return 'assistant';
  return null;
}

function collectText(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const item = part as { type?: string; text?: string };
    if (item.type && /image|audio|file|reasoning|analysis|thinking/i.test(item.type)) continue;
    if (typeof item.text === 'string') texts.push(item.text);
  }
  return texts;
}
