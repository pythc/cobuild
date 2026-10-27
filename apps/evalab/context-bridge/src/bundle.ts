import path from 'node:path';
import { Buffer } from 'node:buffer';
import { sha256Hex } from './canonical.js';
import { readCodexTranscript } from './codex.js';
import { readCursorExport, UnsupportedExport } from './cursorExport.js';
import { MAX_CLIENTS, MAX_LABEL_CHARS, PREVIEW_CHARS } from './limits.js';
import { assertPayloadCoherent } from './payload.js';
import { redactText } from './redact.js';
import type {
  BundlePreview,
  Candidate,
  Coverage,
  MaterialClient,
  MaterialFile,
  MaterialPayload,
} from './types.js';

export type PreparedBundle = {
  payload: MaterialPayload;
  payloadHash: string;
  preview: BundlePreview;
};

export async function buildBundle(options: {
  candidates: Candidate[];
  workspaceReal: string;
  repoSha: string;
  projectSummary: string;
  collaborationSummary: string;
  declaredClients?: MaterialClient[];
}): Promise<PreparedBundle> {
  if (options.candidates.length === 0) throw new Error('Select at least one candidate file');
  const project = redactField(options.projectSummary, 'projectSummary');
  const collaboration = redactField(options.collaborationSummary, 'collaborationSummary');
  const files: Array<{ name: string; content: string }> = [];
  const metas: MaterialFile[] = [];
  const previews: BundlePreview['files'] = [];
  const warnings = new Set<string>();
  const usedNames = new Set<string>();
  const detected: MaterialClient[] = [];

  for (const candidate of options.candidates) {
    const rendered = await renderCandidate(candidate, options.workspaceReal);
    const redacted = redactText(rendered.text);
    if (redacted.redactions > 0) warnings.add('Obvious secrets were redacted locally before hashing.');
    if (rendered.rawTruncated) {
      warnings.add('A Cursor export was larger than 8MB and was truncated before parsing. Coverage is partial.');
    } else if (rendered.truncated) {
      warnings.add('A transcript was truncated to the 1MB file limit. Coverage is partial.');
    }
    if (!candidate.workspaceMatched) {
      warnings.add('A user-selected file did not match the exam workspace. It is not complete account history.');
    }
    const content = redacted.text;
    const name = uniqueName(candidate.relativeName, usedNames);
    const bytes = Buffer.byteLength(content, 'utf8');
    const digest = sha256Hex(content);
    const source = candidate.kind === 'codex-jsonl' ? 'codex-jsonl' : 'cursor-export';
    files.push({ name, content });
    metas.push({ name, sha256: digest, bytes, source, coverage: rendered.coverage });
    previews.push({
      name,
      sha256: digest,
      bytes,
      source,
      coverage: rendered.coverage,
      redactions: redacted.redactions,
      excerpt: content.slice(0, PREVIEW_CHARS),
      excerptTruncated: content.length > PREVIEW_CHARS,
      workspaceMatched: candidate.workspaceMatched,
      selection: candidate.selection,
    });
    detected.push(clientFrom(candidate, rendered.model, rendered.provider, rendered.version));
  }

  const manifest = {
    files: metas,
    clients: mergeClients(detected, options.declaredClients),
    projectSummary: project.text,
    collaborationSummary: collaboration.text,
  };
  if (project.redactions || collaboration.redactions) {
    warnings.add('A summary contained an obvious secret and was redacted locally.');
  }
  const payload: MaterialPayload = {
    schemaVersion: 1,
    repoSha: options.repoSha,
    manifest,
    files,
  };
  const payloadHash = assertPayloadCoherent(payload);
  const totalBytes = metas.reduce((sum, file) => sum + file.bytes, 0);
  return {
    payload,
    payloadHash,
    preview: {
      upload: false,
      payloadHash,
      repoSha: options.repoSha,
      totalBytes,
      fileCount: files.length,
      files: previews,
      clients: manifest.clients,
      projectSummary: project.text,
      collaborationSummary: collaboration.text,
      warnings: [...warnings],
      note: 'Local preview only. File contents have not been uploaded. The candidate must approve this digest in the exam website before submit. Summaries are not raw history, and declared clients or models are not independently verified.',
    },
  };
}

async function renderCandidate(
  candidate: Candidate,
  workspaceReal: string,
): Promise<{ text: string; coverage: Coverage; model?: string; provider?: string; version?: string; truncated: boolean; rawTruncated: boolean }> {
  if (candidate.kind === 'codex-jsonl') {
    const transcript = await readCodexTranscript(candidate.fileReal, workspaceReal);
    return {
      text: renderText({
        origin: 'codex-jsonl',
        coverage: 'partial',
        workspaceMatched: transcript.workspaceMatched,
        selection: candidate.selection,
        note: 'User text and visible assistant final or commentary text only. System prompts, developer prompts, analysis, hidden reasoning, and tool outputs are omitted. This is not an independently verified complete history.',
        turns: transcript.turns,
      }),
      coverage: 'partial',
      model: transcript.model,
      provider: transcript.provider,
      version: transcript.cliVersion,
      truncated: transcript.truncated,
      rawTruncated: false,
    };
  }
  try {
    const transcript = await readCursorExport(candidate.fileReal);
    const coverage: Coverage = transcript.truncated || transcript.omittedHiddenRoles ? 'partial' : 'export';
    return {
      text: renderText({
        origin: 'cursor-export',
        coverage,
        workspaceMatched: false,
        selection: 'user-selected',
        note: transcript.rawTruncated
          ? 'User-selected Cursor conversation export, truncated because the raw file exceeded 8MB. This is not whole-account history. System and developer text is omitted.'
          : 'User-selected Cursor conversation export. This is not whole-account history and was not independently verified. System and developer text is omitted.',
        turns: transcript.turns,
      }),
      coverage,
      model: undefined,
      provider: undefined,
      version: undefined,
      truncated: transcript.truncated,
      rawTruncated: transcript.rawTruncated,
    };
  } catch (error) {
    if (error instanceof UnsupportedExport) throw error;
    throw new UnsupportedExport('This file is not a supported Cursor conversation export. History was not fabricated.');
  }
}

function renderText(input: {
  origin: string;
  coverage: Coverage;
  workspaceMatched: boolean;
  selection: string;
  note: string;
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
}): string {
  const lines = [
    '# Role-filtered exam transcript',
    `origin: ${input.origin}`,
    `coverage: ${input.coverage}`,
    `selection: ${input.selection}`,
    `workspaceMatched: ${input.workspaceMatched ? 'true' : 'false'}`,
    `note: ${input.note}`,
    '',
  ];
  for (const turn of input.turns) {
    lines.push(turn.role === 'user' ? '## User' : '## Assistant', turn.text, '');
  }
  return lines.join('\n');
}

function uniqueName(relativeName: string, used: Set<string>): string {
  const base = path.posix.basename(relativeName).replace(/\.[^.]+$/, '');
  const stem = base.replace(/[\\/:\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').slice(0, 80) || 'transcript';
  let name = `${stem}.txt`;
  let suffix = 2;
  while (used.has(name)) {
    name = `${stem}-${suffix}.txt`;
    suffix += 1;
  }
  used.add(name);
  return name;
}

function clientFrom(
  candidate: Candidate,
  model: string | undefined,
  provider: string | undefined,
  version: string | undefined,
): MaterialClient {
  const detectedName = candidate.detected.modelSource === 'detected' ? candidate.detected.modelName : undefined;
  const modelName = model ?? detectedName;
  const known = Boolean(modelName);
  const parameters: Record<string, string | number | boolean | null> = {};
  if (provider) parameters.provider = provider;
  if (!known) parameters.reason = 'model was not present in the export metadata';
  const clientVersion = clipLabel(version ?? candidate.detected.clientVersion ?? '');
  if (provider && provider.length > 500) parameters.provider = provider.slice(0, 500);
  return {
    name: clipLabel(candidate.detected.clientName),
    ...(clientVersion ? { version: clientVersion } : {}),
    models: [
      {
        name: clipLabel(modelName ?? 'UNKNOWN'),
        source: known ? 'detected' : 'unknown',
        parameters,
      },
    ],
  };
}

function clipLabel(value: string): string {
  return value.trim().replace(/[\u0000-\u001f]/g, '').slice(0, MAX_LABEL_CHARS);
}

function mergeClients(detected: MaterialClient[], declared: MaterialClient[] | undefined): MaterialClient[] {
  const merged = [...detected];
  for (const client of declared ?? []) {
    const name = clipLabel(client.name);
    const version = client.version === undefined ? '' : clipLabel(client.version);
    if (!name) throw new Error('client name is empty');
    if (client.models.length < 1) throw new Error('each client needs at least one model');
    merged.push({
      name,
      ...(version ? { version } : {}),
      models: client.models.map((model) => ({
        name: clipLabel(model.name) || 'UNKNOWN',
        source: 'reported' as const,
        ...(model.parameters ? { parameters: model.parameters } : {}),
      })),
    });
  }
  if (merged.length === 0) {
    merged.push({
      name: 'UNKNOWN',
      models: [{ name: 'UNKNOWN', source: 'unknown', parameters: { reason: 'client was not identified' } }],
    });
  }
  return merged.slice(0, MAX_CLIENTS);
}

function redactField(value: string, label: string): { text: string; redactions: number } {
  const redacted = redactText(value.trim());
  if (redacted.text.length === 0) throw new Error(`${label} is empty after redaction`);
  return redacted;
}
