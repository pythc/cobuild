import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);

export function assertSafeRoot(realPath: string): void {
  const home = realpathSync(homedir());
  const fsRoot = realpathSync(path.parse(realPath).root);
  if (realPath === fsRoot || realPath === home || realPath === path.dirname(home)) {
    throw new Error('A context root is too broad');
  }
}

export function isContained(rootReal: string, targetReal: string): boolean {
  const root = path.resolve(rootReal);
  const target = path.resolve(targetReal);
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

export function relativeDisplay(rootReal: string, fileReal: string): string {
  const rel = path.relative(rootReal, fileReal);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path is outside an authorized root');
  }
  return rel.split(path.sep).join('/');
}

export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

export function isSensitiveFileName(name: string): boolean {
  const base = path.basename(name);
  return /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials\.json|secrets\.json|.*\.(?:pem|key|p12|pfx))$/i.test(base);
}

export async function resolveInsideRoots(roots: string[], raw: string): Promise<string | null> {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  const candidates = path.isAbsolute(trimmed)
    ? [path.resolve(trimmed)]
    : roots.map((root) => path.resolve(root, trimmed));
  for (const candidate of candidates) {
    const located = await locateFile(roots, candidate);
    if (located) return located;
  }
  return null;
}

async function locateFile(roots: string[], candidate: string): Promise<string | null> {
  let info;
  try {
    info = await lstat(candidate);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  if (isSensitiveFileName(candidate)) return null;
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return null;
  }
  const allowed = roots.some((root) => isContained(root, real));
  if (!allowed) return null;
  let realInfo;
  try {
    realInfo = await lstat(real);
  } catch {
    return null;
  }
  if (realInfo.isSymbolicLink() || !realInfo.isFile()) return null;
  return real;
}
