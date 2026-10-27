import { lstat, readdir, realpath } from 'node:fs/promises';
import { inspectCodexHead, workspaceMatches } from './codex.js';
import { cursorHeadSupported } from './cursorExport.js';
import { HEAD_BYTES, MAX_CANDIDATES, MAX_WALK_DEPTH, MAX_WALK_ENTRIES } from './limits.js';
import { readHead } from './lines.js';
import { sha256Hex } from './canonical.js';
import {
  isContained,
  isSensitiveFileName,
  relativeDisplay,
  resolveInsideRoots,
  shouldSkipDir,
} from './scope.js';
import path from 'node:path';
import type { Candidate, PublicCandidate } from './types.js';

export type DiscoverResult = {
  candidates: PublicCandidate[];
  catalog: Candidate[];
  warnings: string[];
  unsupported: Array<{ label: string; reason: string }>;
};

export async function discover(options: {
  roots: string[];
  workspaceReal: string;
  explicitPaths?: string[];
}): Promise<DiscoverResult> {
  const warnings: string[] = [];
  const unsupported: Array<{ label: string; reason: string }> = [];
  const catalog: Candidate[] = [];
  const seen = new Set<string>();
  let capped = false;

  if (!options.explicitPaths) {
    for (const root of options.roots) {
      await walk(root, root, 0, options.workspaceReal, catalog, seen, () => {
        capped = true;
      });
    }
  } else {
    let index = 0;
    for (const raw of options.explicitPaths.slice(0, 20)) {
      index += 1;
      const label = `selected-file-${index}`;
      if (isSensitiveFileName(raw)) {
        unsupported.push({
          label,
          reason: 'sensitive file names are not read. History was not fabricated.',
        });
        continue;
      }
      if (/\.(?:vscdb|sqlite|db)$/i.test(path.basename(raw))) {
        unsupported.push({
          label,
          reason: 'unsupported_export: database files are not a supported conversation export. History was not fabricated.',
        });
        continue;
      }
      const located = await resolveInsideRoots(options.roots, raw);
      if (!located) {
        unsupported.push({
          label,
          reason: 'outside authorized roots, a symlink, or not a regular file. Nothing was read from outside the roots.',
        });
        continue;
      }
      const candidate = await classifyFile(options.roots, located, options.workspaceReal, 'user-selected');
      if (!candidate) {
        unsupported.push({
          label,
          reason: 'unsupported_export: not a supported project conversation file. History was not fabricated.',
        });
        continue;
      }
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      catalog.push(candidate);
      if (!candidate.workspaceMatched && candidate.kind === 'codex-jsonl') {
        warnings.push(
          'A selected Codex session did not match the exam workspace. It is included only because it was selected, and it is not complete account history.',
        );
      }
    }
  }

  if (capped) warnings.push('The scan stopped early because the authorized root is large. Narrow the context root.');
  return {
    candidates: catalog.slice(0, MAX_CANDIDATES).map(toPublic),
    catalog: catalog.slice(0, MAX_CANDIDATES),
    warnings,
    unsupported,
  };
}

async function walk(
  rootReal: string,
  dir: string,
  depth: number,
  workspaceReal: string,
  catalog: Candidate[],
  seen: Set<string>,
  onCap: () => void,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH || seen.size >= MAX_WALK_ENTRIES || catalog.length >= MAX_CANDIDATES) {
    onCap();
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (seen.size >= MAX_WALK_ENTRIES || catalog.length >= MAX_CANDIDATES) {
      onCap();
      return;
    }
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    seen.add(full);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      let realDir: string;
      try {
        realDir = await realpath(full);
      } catch {
        continue;
      }
      if (!isContained(rootReal, realDir)) continue;
      await walk(rootReal, full, depth + 1, workspaceReal, catalog, seen, onCap);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    if (isSensitiveFileName(entry.name)) continue;
    const candidate = await classifyFile([rootReal], full, workspaceReal, 'workspace-match');
    if (!candidate || candidate.kind !== 'codex-jsonl' || !candidate.workspaceMatched) continue;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    catalog.push(candidate);
  }
}

async function classifyFile(
  roots: string[],
  filePath: string,
  workspaceReal: string,
  selection: Candidate['selection'],
): Promise<Candidate | null> {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  if (isSensitiveFileName(filePath)) return null;
  if (/\.(?:vscdb|sqlite|db)$/i.test(filePath)) return null;
  let fileReal: string;
  try {
    fileReal = await realpath(filePath);
  } catch {
    return null;
  }
  if (!roots.some((root) => isContained(root, fileReal))) return null;
  const rootReal = roots.find((root) => isContained(root, fileReal));
  if (!rootReal) return null;
  let head = '';
  try {
    head = await readHead(fileReal, HEAD_BYTES);
  } catch {
    return null;
  }
  const codex = inspectCodexHead(head);
  if (codex) {
    const matched = workspaceMatches(codex.cwd, workspaceReal);
    if (selection === 'workspace-match' && !matched) return null;
    return {
      id: candidateId(rootReal, fileReal),
      rootReal,
      fileReal,
      relativeName: relativeDisplay(rootReal, fileReal),
      kind: 'codex-jsonl',
      selection: matched ? 'workspace-match' : 'user-selected',
      workspaceMatched: matched,
      bytes: info.size,
      detected: {
        clientName: 'Codex CLI',
        ...(codex.cliVersion ? { clientVersion: codex.cliVersion } : {}),
        ...(codex.model ? { modelName: codex.model } : {}),
        modelSource: codex.model ? 'detected' : 'unknown',
        ...(codex.provider ? { provider: codex.provider } : {}),
      },
    };
  }
  if (selection !== 'user-selected') return null;
  if (!/\.(?:json|jsonl|md|markdown|txt|log)$/i.test(fileReal)) return null;
  const isCursor = cursorHeadSupported(fileReal, head);
  return {
    id: candidateId(rootReal, fileReal),
    rootReal,
    fileReal,
    relativeName: relativeDisplay(rootReal, fileReal),
    kind: isCursor ? 'cursor-export' : 'raw-export',
    selection: 'user-selected',
    workspaceMatched: false,
    bytes: info.size,
    detected: {
      clientName: isCursor ? 'Cursor' : 'unknown',
      modelSource: 'unknown',
    },
  };
}

function candidateId(rootReal: string, fileReal: string): string {
  return sha256Hex(`${rootReal}\n${fileReal}`).slice(0, 24);
}

function toPublic(candidate: Candidate): PublicCandidate {
  return {
    id: candidate.id,
    relativeName: candidate.relativeName,
    kind: candidate.kind,
    selection: candidate.selection,
    workspaceMatched: candidate.workspaceMatched,
    bytes: candidate.bytes,
    clientName: candidate.detected.clientName,
    ...(candidate.detected.clientVersion ? { clientVersion: candidate.detected.clientVersion } : {}),
    modelName: candidate.detected.modelName ?? 'UNKNOWN',
    modelSource: candidate.detected.modelSource,
  };
}
