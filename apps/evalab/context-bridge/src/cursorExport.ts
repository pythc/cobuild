import { lstat } from 'node:fs/promises';
import { MAX_CURSOR_RAW_BYTES, MAX_FILE_BYTES } from './limits.js';
import { forEachLine } from './lines.js';
import type { TranscriptTurn } from './codex.js';

export type CursorTranscript = {
  turns: TranscriptTurn[];
  truncated: boolean;
  rawTruncated: boolean;
  omittedHiddenRoles: boolean;
};

const UNSUPPORTED = 'unsupported_export';

export class UnsupportedExport extends Error {
  readonly code = UNSUPPORTED;
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedExport';
  }
}

export function cursorHeadSupported(fileName: string, head: string): boolean {
  if (/\.(?:vscdb|sqlite|db)$/i.test(fileName)) return false;
  if (/"type"\s*:\s*"session_meta"/.test(head.slice(0, 800))) return false;
  const sample = head.slice(0, 4000);
  if (/\[USER\]/i.test(sample) && /\[ASSISTANT\]/i.test(head)) return true;
  if (/\bCursor\b/.test(sample) && /^(?:#{1,3}\s+|\*\*)(User|Assistant|Cursor)\b/im.test(head)) return true;
  let lines = head.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (head.length >= 65_536) lines = lines.slice(0, -1);
  lines = lines.slice(0, 20);
  if (lines.length === 0 || lines.some((line) => !line.startsWith('{'))) return false;
  let visible = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { role?: unknown };
      const role = typeof parsed.role === 'string' ? parsed.role.toLowerCase() : '';
      if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') return false;
      if (role === 'user' || role === 'assistant') visible += 1;
    } catch {
      return false;
    }
  }
  return visible > 0;
}

export async function readCursorExport(file: string): Promise<CursorTranscript> {
  const info = await lstat(file);
  if (!info.isFile()) {
    throw new UnsupportedExport('This file is not a supported Cursor conversation export. History was not fabricated.');
  }
  let rawTruncated = info.size > MAX_CURSOR_RAW_BYTES;
  const lines: string[] = [];
  let rawBytes = 0;
  await forEachLine(file, (line) => {
    const next = Buffer.byteLength(line, 'utf8') + 1;
    if (rawBytes + next > MAX_CURSOR_RAW_BYTES) {
      rawTruncated = true;
      return 'stop';
    }
    rawBytes += next;
    lines.push(line);
  });
  const text = lines.join('\n');
  if (looksLikeDatabaseName(file)) {
    throw new UnsupportedExport(
      'Cursor database files are not a supported export. Select a text or markdown conversation export. History was not fabricated.',
    );
  }
  const jsonl = tryCursorJsonl(lines);
  if (jsonl) return fit(jsonl.turns, jsonl.omittedHiddenRoles, rawTruncated);
  const marked = tryMarkedTranscript(text);
  if (marked) return fit(marked.turns, marked.omittedHiddenRoles, rawTruncated);
  throw new UnsupportedExport(
    'This file is not a supported Cursor conversation export. History was not fabricated.',
  );
}

function looksLikeDatabaseName(file: string): boolean {
  return /\.(?:vscdb|sqlite|db)$/i.test(file);
}

function tryCursorJsonl(lines: string[]): { turns: TranscriptTurn[]; omittedHiddenRoles: boolean } | null {
  const contentLines = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (contentLines.length === 0) return null;
  if (contentLines.some((line) => /"type"\s*:\s*"session_meta"/.test(line.slice(0, 500)))) return null;
  const turns: TranscriptTurn[] = [];
  let omittedHiddenRoles = false;
  for (const line of contentLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as { role?: unknown; content?: unknown; type?: unknown };
    if (record.type === 'session_meta') return null;
    const role = typeof record.role === 'string' ? record.role.toLowerCase() : '';
    if (!role) return null;
    if (role === 'system' || role === 'developer') {
      omittedHiddenRoles = true;
      continue;
    }
    if (role !== 'user' && role !== 'assistant') return null;
    const text = flattenContent(record.content).trim();
    if (!text) continue;
    turns.push({ role, text });
  }
  if (turns.length === 0) return null;
  return { turns, omittedHiddenRoles };
}

function tryMarkedTranscript(text: string): { turns: TranscriptTurn[]; omittedHiddenRoles: boolean } | null {
  const head = text.slice(0, 4000);
  const bracket = /\[(USER|ASSISTANT|SYSTEM|DEVELOPER)\]/i.test(head) && /\[USER\]/i.test(text) && /\[ASSISTANT\]/i.test(text);
  const cursorMarked = /\bCursor\b/.test(head) && /^(?:#{1,3}\s+|\*\*)(User|Assistant|Cursor|System|Developer)\b/im.test(text);
  if (!bracket && !cursorMarked) return null;
  const turns: TranscriptTurn[] = [];
  let omittedHiddenRoles = false;
  let role: 'user' | 'assistant' | 'skip' | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (!role) {
      buffer = [];
      return;
    }
    const textBody = buffer.join('\n').trim();
    buffer = [];
    if (!textBody || role === 'skip') {
      if (role === 'skip' && textBody) omittedHiddenRoles = true;
      return;
    }
    turns.push({ role, text: textBody });
  };
  for (const line of text.split(/\r?\n/)) {
    const next = headingRole(line);
    if (next) {
      flush();
      role = next;
      continue;
    }
    if (role) buffer.push(line);
  }
  flush();
  if (turns.length === 0) return null;
  return { turns, omittedHiddenRoles };
}

function headingRole(line: string): 'user' | 'assistant' | 'skip' | null {
  const bracket = /^\[(USER|ASSISTANT|SYSTEM|DEVELOPER)\]\s*$/i.exec(line.trim());
  const heading = /^(?:#{1,3}\s+|\*\*)(User|Assistant|Cursor|System|Developer)\**\s*$/i.exec(line.trim());
  const label = (bracket?.[1] ?? heading?.[1] ?? '').toLowerCase();
  if (!label) return null;
  if (label === 'user') return 'user';
  if (label === 'assistant' || label === 'cursor') return 'assistant';
  if (label === 'system' || label === 'developer') return 'skip';
  return null;
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const item = part as { type?: string; text?: string };
    if (item.type && /image|audio|file/i.test(item.type)) continue;
    if (typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n');
}

function fit(turns: TranscriptTurn[], omittedHiddenRoles: boolean, rawTruncated: boolean): CursorTranscript {
  const kept: TranscriptTurn[] = [];
  let bytes = 0;
  let truncated = rawTruncated;
  for (const turn of turns) {
    const next = Buffer.byteLength(turn.text, 'utf8') + 16;
    if (bytes + next > MAX_FILE_BYTES) {
      truncated = true;
      break;
    }
    bytes += next;
    kept.push(turn);
  }
  if (kept.length === 0) {
    throw new UnsupportedExport('The export has no user or assistant text. History was not fabricated.');
  }
  return { turns: kept, truncated, rawTruncated, omittedHiddenRoles };
}
