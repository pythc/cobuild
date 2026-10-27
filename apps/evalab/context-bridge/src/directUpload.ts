import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_FILES, MAX_UPLOAD_BYTES, MAX_UPLOAD_CHUNK_BYTES } from './limits.js';
import { isContained, isSensitiveFileName } from './scope.js';
import type { Coverage } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^lu_[A-Za-z0-9_-]{43}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const REPO_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NAME_BAD = /[\\/:\u0000-\u001f\u007f]/;
const HASH_READ = 64 * 1024;
const MAX_RESPONSE = 256 * 1024;
const MAX_ATTEMPTS = 5;
const backoff = (attempt: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(4000, 250 * 2 ** (attempt - 1))));
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const OPEN_STATUS = new Set(['AWAITING_FILES', 'UPLOADING']);
const DEAD_STATUS = new Set(['SUPERSEDED', 'EXPIRED', 'REJECTED', 'FAILED']);

export type UploadTicket = {
  uploadId: string;
  uploadUrl: string;
  uploadToken: string;
  maxTotalBytes: number;
  chunkBytes: number;
};

export type UploadFileResult = {
  name: string;
  sha256: string;
  bytes: number;
  coverage: Coverage;
};

export type UploadReceipt = {
  id: string;
  sha256: string;
  repoSha: string;
  receivedAt: string;
};

export type UploadResult = {
  status: 'RECEIVED';
  totalBytes: number;
  files: UploadFileResult[];
  receipt: UploadReceipt;
};

type Snapshot = {
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
};

type PreparedFile = UploadFileResult & {
  fileReal: string;
  snap: Snapshot;
};

type RemoteFile = {
  id: string;
  name: string;
  sha256: string;
  bytes: number;
  receivedBytes: number;
};

type RemoteView = {
  status: string;
  files: RemoteFile[];
  receipt?: UploadReceipt;
};

class Retryable extends Error {}

export function assertUploadToken(token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error('upload token is not a direct-upload ticket');
  return token;
}

export function assertTicketUrl(assessmentOrigin: string, raw: string): URL {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(raw);
    expected = new URL(assessmentOrigin);
  } catch {
    throw new Error('upload URL is not allowed');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('upload URL is not allowed');
  if (url.origin !== expected.origin) throw new Error('upload URL origin is not allowed');
  if (!allowedProtocol(url)) throw new Error('upload URL is not allowed');
  const match = /^\/material-uploads\/([^/]+)$/.exec(url.pathname);
  if (!match || !UUID_RE.test(match[1] ?? '')) throw new Error('upload URL is not allowed');
  return url;
}

export function boundedChunkBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('upload ticket limits are not allowed');
  return Math.min(value, MAX_UPLOAD_CHUNK_BYTES);
}

export async function uploadRawFiles(options: {
  assessmentOrigin: string;
  roots: string[];
  files: Array<{ fileReal: string; relativeName: string; coverage: Coverage }>;
  openTicket: (totalBytes: number) => Promise<UploadTicket>;
  snapshotSource?: boolean;
}): Promise<UploadResult> {
  if (options.files.length < 1 || options.files.length > MAX_FILES) throw new Error('file count is not allowed');
  const snapshotSource = options.snapshotSource === true;
  let scratch: string | undefined;
  let failure: unknown;
  try {
    let prepared: PreparedFile[];
    if (snapshotSource) {
      const located = await locateAll(options.roots, options.files);
      scratch = await mkdtemp(path.join(tmpdir(), 'assessment-snap-'));
      await chmod(scratch, 0o700);
      prepared = await writeSnapshots(options.roots, located, scratch);
    } else {
      prepared = await prepareFiles(options.roots, options.files);
    }
    const totalBytes = prepared.reduce((sum, file) => sum + file.bytes, 0);
    if (totalBytes > MAX_UPLOAD_BYTES) throw new Error('files exceed 1GiB');
    const ticket = await options.openTicket(totalBytes);
    const uploadUrl = assertTicketUrl(options.assessmentOrigin, ticket.uploadUrl);
    const token = assertUploadToken(ticket.uploadToken);
    if (ticket.uploadId.toLowerCase() !== uploadUrl.pathname.split('/').pop()?.toLowerCase()) {
      throw new Error('upload URL is not allowed');
    }
    const maxTotal = ticket.maxTotalBytes;
    if (!Number.isSafeInteger(maxTotal) || maxTotal < 1 || maxTotal > MAX_UPLOAD_BYTES) {
      throw new Error('upload ticket limits are not allowed');
    }
    if (totalBytes > maxTotal) throw new Error('files exceed the upload limit');
    const chunkBytes = boundedChunkBytes(ticket.chunkBytes);
    const view = await postManifest(uploadUrl, token, prepared, snapshotSource);
    await sendAll(uploadUrl, token, prepared, view, chunkBytes);
    await rehashAll(prepared);
    const done = await postComplete(uploadUrl, token);
    return {
      status: 'RECEIVED',
      totalBytes,
      files: prepared.map((file) => ({
        name: file.name,
        sha256: file.sha256,
        bytes: file.bytes,
        coverage: file.coverage,
      })),
      receipt: done,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (scratch) {
      try {
        await rm(scratch, { recursive: true, force: true });
      } catch {
        if (failure === undefined) throw new Error('upload snapshot cleanup failed');
      }
    }
  }
}

type LocatedFile = {
  fileReal: string;
  coverage: Coverage;
  snap: Snapshot;
  name: string;
};

async function prepareFiles(
  roots: string[],
  files: Array<{ fileReal: string; relativeName: string; coverage: Coverage }>,
): Promise<PreparedFile[]> {
  const located = await locateAll(roots, files);
  const prepared: PreparedFile[] = [];
  for (const file of located) {
    prepared.push({
      fileReal: file.fileReal,
      name: file.name,
      sha256: await hashHandle(file.fileReal, file.snap),
      bytes: file.snap.size,
      coverage: file.coverage,
      snap: file.snap,
    });
  }
  return prepared;
}

async function locateAll(
  roots: string[],
  files: Array<{ fileReal: string; relativeName: string; coverage: Coverage }>,
): Promise<LocatedFile[]> {
  const used = new Set<string>();
  const seen = new Set<string>();
  const locatedFiles: LocatedFile[] = [];
  let total = 0;
  for (const file of files) {
    const located = await locateAuthorized(roots, file.fileReal);
    const key = `${located.snap.dev}:${located.snap.ino}`;
    if (seen.has(key)) throw new Error('duplicate file');
    seen.add(key);
    total += located.snap.size;
    if (total > MAX_UPLOAD_BYTES) throw new Error('files exceed 1GiB');
    locatedFiles.push({
      fileReal: located.fileReal,
      coverage: file.coverage,
      snap: located.snap,
      name: uploadName(file.relativeName, used),
    });
  }
  return locatedFiles;
}

async function writeSnapshots(roots: string[], located: LocatedFile[], scratch: string): Promise<PreparedFile[]> {
  const prepared: PreparedFile[] = [];
  const root = path.resolve(scratch);
  for (let index = 0; index < located.length; index += 1) {
    const file = located[index];
    if (!file) throw new Error('file changed while capturing');
    const dest = path.join(root, String(index));
    if (path.dirname(dest) !== root || path.resolve(dest) !== dest) throw new Error('file changed while capturing');
    const prefixHash = await capturePrefix(roots, file.fileReal, file.snap, dest);
    const tempSnap = await snapshotFile(dest);
    if (tempSnap.size !== file.snap.size) throw new Error('file changed while capturing');
    const sha256 = await hashHandle(dest, tempSnap);
    if (sha256 !== prefixHash) throw new Error('file changed while capturing');
    prepared.push({
      fileReal: dest,
      name: file.name,
      sha256,
      bytes: tempSnap.size,
      coverage: file.coverage,
      snap: tempSnap,
    });
  }
  return prepared;
}

async function capturePrefix(roots: string[], fileReal: string, snap: Snapshot, dest: string): Promise<string> {
  if (snap.size < 1) throw new Error('file is empty');
  const handle = await openNoFollow(fileReal);
  let out: FileHandle | undefined;
  let ok = false;
  try {
    const stats = await handle.stat();
    if (!prefixIdentity(stats, snap)) throw new Error('file changed while capturing');
    try {
      out = await open(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await out.chmod(0o600);
    } catch {
      throw new Error('file changed while capturing');
    }
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(HASH_READ);
    let offset = 0;
    while (offset < snap.size) {
      const length = Math.min(buf.length, snap.size - offset);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      if (bytesRead === 0) throw new Error('file changed while capturing');
      const chunk = Buffer.from(buf.subarray(0, bytesRead));
      await writeFull(out, chunk);
      hash.update(chunk);
      offset += bytesRead;
    }
    const mid = await handle.stat();
    if (!prefixIdentity(mid, snap)) throw new Error('file changed while capturing');
    const again = createHash('sha256');
    let check = 0;
    while (check < snap.size) {
      const length = Math.min(buf.length, snap.size - check);
      const { bytesRead } = await handle.read(buf, 0, length, check);
      if (bytesRead === 0) throw new Error('file changed while capturing');
      again.update(buf.subarray(0, bytesRead));
      check += bytesRead;
    }
    const prefixHash = hash.digest('hex');
    if (prefixHash !== again.digest('hex')) throw new Error('file changed while capturing');
    const after = await handle.stat();
    if (!prefixIdentity(after, snap)) throw new Error('file changed while capturing');
    await assertPathBound(roots, fileReal, snap);
    ok = true;
    return prefixHash;
  } catch (error) {
    if (error instanceof Error && (
      error.message === 'file changed while capturing'
      || error.message === 'file is empty'
      || error.message === 'candidate is outside authorized roots'
      || error.message === 'candidate file is not allowed'
      || error.message === 'candidate is not a regular file'
    )) throw error;
    throw new Error('file changed while capturing');
  } finally {
    await handle.close().catch(() => undefined);
    if (out) await out.close().catch(() => undefined);
    if (!ok) await rm(dest, { force: true }).catch(() => undefined);
  }
}

function prefixIdentity(stats: Stats, snap: Snapshot): boolean {
  return stats.isFile() && stats.ino === snap.ino && stats.dev === snap.dev && stats.size >= snap.size;
}

async function writeFull(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    if (bytesWritten <= 0) throw new Error('file changed while capturing');
    offset += bytesWritten;
  }
}

async function assertPathBound(roots: string[], fileReal: string, snap: Snapshot): Promise<void> {
  let listed: Stats;
  try {
    listed = await lstat(fileReal);
  } catch {
    throw new Error('file changed while capturing');
  }
  if (listed.isSymbolicLink() || !prefixIdentity(listed, snap)) throw new Error('file changed while capturing');
  let real: string;
  try {
    real = await realpath(fileReal);
  } catch {
    throw new Error('file changed while capturing');
  }
  if (real !== fileReal) throw new Error('file changed while capturing');
  if (!roots.some((root) => isContained(root, real))) throw new Error('candidate is outside authorized roots');
  if (isSensitiveFileName(real)) throw new Error('candidate file is not allowed');
}

async function locateAuthorized(roots: string[], fileReal: string): Promise<{ fileReal: string; snap: Snapshot }> {
  let listed: Stats;
  try {
    listed = await lstat(fileReal);
  } catch {
    throw new Error('candidate file is not available');
  }
  if (listed.isSymbolicLink() || !listed.isFile()) throw new Error('candidate is not a regular file');
  if (isSensitiveFileName(fileReal)) throw new Error('candidate file is not allowed');
  let real: string;
  try {
    real = await realpath(fileReal);
  } catch {
    throw new Error('candidate file is not available');
  }
  if (!roots.some((root) => isContained(root, real))) throw new Error('candidate is outside authorized roots');
  if (real !== fileReal) throw new Error('candidate path changed');
  const snap = await snapshotFile(real);
  return { fileReal: real, snap };
}

async function snapshotFile(fileReal: string): Promise<Snapshot> {
  const handle = await openNoFollow(fileReal);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('candidate is not a regular file');
    if (stats.size < 1) throw new Error('file is empty');
    if (!Number.isSafeInteger(stats.size)) throw new Error('files exceed 1GiB');
    return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino, dev: stats.dev };
  } finally {
    await handle.close();
  }
}

async function openNoFollow(fileReal: string) {
  try {
    return await open(fileReal, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('candidate is not a regular file');
  }
}

function sameSnap(stats: Stats, snap: Snapshot): boolean {
  return stats.isFile()
    && stats.size === snap.size
    && stats.mtimeMs === snap.mtimeMs
    && stats.ino === snap.ino
    && stats.dev === snap.dev;
}

async function hashHandle(fileReal: string, snap: Snapshot): Promise<string> {
  const handle = await openNoFollow(fileReal);
  try {
    const stats = await handle.stat();
    if (!sameSnap(stats, snap)) throw new Error('file changed while sending');
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(HASH_READ);
    let offset = 0;
    while (offset < snap.size) {
      const length = Math.min(buf.length, snap.size - offset);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buf, filled, length - filled, offset + filled);
        if (bytesRead === 0) throw new Error('file changed while sending');
        filled += bytesRead;
      }
      hash.update(buf.subarray(0, length));
      offset += length;
    }
    const after = await handle.stat();
    if (!sameSnap(after, snap)) throw new Error('file changed while sending');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function uploadName(relativeName: string, used: Set<string>): string {
  const parts = relativeName.split('/').filter((part) => part.length > 0 && part !== '.' && part !== '..');
  const base = parts.join('__');
  if (base.length < 1 || base.length > 200 || NAME_BAD.test(base)) throw new Error('file name is not allowed');
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let index = 2; index < 100; index += 1) {
    const suffix = `-${index}`;
    const room = 200 - ext.length - suffix.length;
    if (room < 1) break;
    const next = `${stem.slice(0, room)}${suffix}${ext}`;
    if (!used.has(next) && !NAME_BAD.test(next)) {
      used.add(next);
      return next;
    }
  }
  throw new Error('file name is not allowed');
}

function childUrl(uploadUrl: URL, suffix: string): URL {
  const target = new URL(uploadUrl.href);
  target.pathname = `${uploadUrl.pathname}${suffix}`;
  target.search = '';
  target.hash = '';
  return target;
}

async function postManifest(
  uploadUrl: URL,
  token: string,
  files: PreparedFile[],
  conflictOnChange = false,
): Promise<RemoteView> {
  const body = Buffer.from(JSON.stringify({
    files: files.map((file) => ({
      name: file.name,
      sha256: file.sha256,
      bytes: file.bytes,
      source: 'agent-export',
      coverage: file.coverage,
    })),
  }));
  let stalls = 0;
  while (stalls <= MAX_ATTEMPTS) {
    let retry = false;
    try {
      const response = await exchange(childUrl(uploadUrl, '/manifest'), 'POST', token, body, 'application/json');
      if (response.status === 200) {
        const view = parseView(response.body);
        if (manifestMatches(view, files)) return view;
        if (conflictOnChange && view.files.length > 0) {
          throw new Error('upload manifest conflicts with this ticket; create a new upload');
        }
        retry = true;
      } else if (response.status === 401 || response.status === 403) {
        throw new Error('upload ticket was rejected');
      } else if (response.status === 409 && conflictOnChange && errorCode(response.body) !== 'UPLOAD_BUSY') {
        try {
          const view = await getView(uploadUrl, token);
          if (manifestMatches(view, files)) return view;
        } catch (error) {
          if (error instanceof Retryable) retry = true;
          else throw error;
        }
        if (!retry) throw new Error('upload manifest conflicts with this ticket; create a new upload');
      } else if (RETRY_STATUS.has(response.status)) {
        retry = true;
      } else {
        throw new Error('upload manifest was rejected');
      }
    } catch (error) {
      if (error instanceof Retryable) retry = true;
      else throw error;
    }
    if (!retry) throw new Error('upload manifest was rejected');
    stalls += 1;
    if (stalls > MAX_ATTEMPTS) break;
    await backoff(stalls);
    try {
      const view = await getView(uploadUrl, token);
      if (manifestMatches(view, files)) return view;
      if (conflictOnChange && view.files.length > 0) {
        throw new Error('upload manifest conflicts with this ticket; create a new upload');
      }
    } catch (error) {
      if (!(error instanceof Retryable)) throw error;
    }
  }
  throw new Error('upload manifest was rejected');
}

function errorCode(body: Buffer): string | null {
  try {
    const value = JSON.parse(body.toString('utf8')) as { code?: unknown };
    return value && typeof value.code === 'string' && value.code.length > 0 && value.code.length <= 64
      ? value.code
      : null;
  } catch {
    return null;
  }
}

function manifestMatches(view: RemoteView, files: PreparedFile[]): boolean {
  if (!OPEN_STATUS.has(view.status) && view.status !== 'RECEIVED') return false;
  if (view.files.length !== files.length) return false;
  const byName = new Map(view.files.map((file) => [file.name, file]));
  return files.every((file) => {
    const remote = byName.get(file.name);
    return remote?.sha256 === file.sha256 && remote.bytes === file.bytes && UUID_RE.test(remote.id);
  });
}

async function sendAll(
  uploadUrl: URL,
  token: string,
  files: PreparedFile[],
  view: RemoteView,
  chunkBytes: number,
): Promise<void> {
  for (const file of files) {
    const remote = view.files.find((item) => item.name === file.name);
    if (!remote) throw new Error('upload manifest was rejected');
    let offset = remote.receivedBytes;
    if (offset < 0 || offset > file.bytes) throw new Error('upload offset was rejected');
    let stalls = 0;
    while (offset < file.bytes) {
      const length = Math.min(chunkBytes, file.bytes - offset);
      let payload: Buffer;
      try {
        payload = await readAt(file, offset, length);
      } catch (error) {
        if (error instanceof Error && error.message === 'file changed while sending') throw error;
        throw new Error('file changed while sending');
      }
      try {
        const target = new URL(uploadUrl.href);
        target.pathname = `${uploadUrl.pathname}/files/${remote.id}`;
        target.search = `?offset=${offset}`;
        const response = await exchange(target, 'PUT', token, payload, 'application/octet-stream');
        if (response.status === 200 || response.status === 201) {
          const received = parseReceived(response.body);
          if (received <= offset || received > offset + length) {
            stalls += 1;
            if (stalls > MAX_ATTEMPTS) throw new Error('upload offset was rejected');
            await backoff(stalls);
            offset = await refreshOffset(uploadUrl, token, file, remote.id);
            continue;
          }
          offset = received;
          stalls = 0;
          continue;
        }
        if (response.status === 401 || response.status === 403) throw new Error('upload ticket was rejected');
        if (!RETRY_STATUS.has(response.status)) throw new Error('upload was rejected');
      } catch (error) {
        if (error instanceof Retryable) {
          // Resume from the committed offset.
        } else if (error instanceof Error && (
          error.message === 'upload ticket was rejected'
          || error.message === 'upload was rejected'
          || error.message === 'file changed while sending'
          || error.message === 'upload offset was rejected'
        )) {
          throw error;
        } else {
          throw new Error('upload was rejected');
        }
      }
      stalls += 1;
      if (stalls > MAX_ATTEMPTS) throw new Error('upload failed after retries');
      await backoff(stalls);
      let next = offset;
      try {
        next = await refreshOffset(uploadUrl, token, file, remote.id);
      } catch (error) {
        if (!(error instanceof Retryable)) throw error;
        continue;
      }
      if (next > offset) stalls = 0;
      offset = next;
    }
    if (offset !== file.bytes) throw new Error('upload did not finish');
  }
}

async function refreshOffset(uploadUrl: URL, token: string, file: PreparedFile, id: string): Promise<number> {
  const view = await getView(uploadUrl, token);
  if (DEAD_STATUS.has(view.status)) throw new Error('upload ticket is no longer accepted');
  const remote = view.files.find((item) => item.id === id && item.name === file.name);
  if (!remote || remote.sha256 !== file.sha256 || remote.bytes !== file.bytes) {
    throw new Error('upload manifest was rejected');
  }
  if (remote.receivedBytes < 0 || remote.receivedBytes > file.bytes) throw new Error('upload offset was rejected');
  return remote.receivedBytes;
}

async function readAt(file: PreparedFile, offset: number, length: number): Promise<Buffer> {
  const handle = await openNoFollow(file.fileReal);
  try {
    const before = await handle.stat();
    if (!sameSnap(before, file.snap)) throw new Error('file changed while sending');
    const exact = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(exact, filled, length - filled, offset + filled);
      if (bytesRead === 0) throw new Error('file changed while sending');
      filled += bytesRead;
    }
    const after = await handle.stat();
    if (!sameSnap(after, file.snap)) throw new Error('file changed while sending');
    return exact;
  } finally {
    await handle.close();
  }
}

async function rehashAll(files: PreparedFile[]): Promise<void> {
  for (const file of files) {
    const digest = await hashHandle(file.fileReal, file.snap);
    if (digest !== file.sha256) throw new Error('file changed while sending');
  }
}

async function postComplete(uploadUrl: URL, token: string): Promise<UploadReceipt> {
  const body = Buffer.from('{}');
  let stalls = 0;
  while (stalls <= MAX_ATTEMPTS) {
    try {
      const response = await exchange(childUrl(uploadUrl, '/complete'), 'POST', token, body, 'application/json');
      if (response.status === 200) return parseComplete(response.body);
      if (response.status === 401 || response.status === 403) throw new Error('upload ticket was rejected');
      if (response.status === 409) {
        const view = await getView(uploadUrl, token);
        if (view.status === 'RECEIVED' && view.receipt) return view.receipt;
        if ((parseJson(response.body) as {code?: string}).code !== 'UPLOAD_BUSY') throw new Error('upload did not finish');
      }
      if (!RETRY_STATUS.has(response.status)) throw new Error('upload did not finish');
    } catch (error) {
      if (!(error instanceof Retryable)) throw error;
    }
    stalls += 1;
    if (stalls > MAX_ATTEMPTS) break;
    await backoff(stalls);
    try {
      const view = await getView(uploadUrl, token);
      if (view.status === 'RECEIVED' && view.receipt) return view.receipt;
    } catch (error) {
      if (!(error instanceof Retryable)) throw error;
    }
  }
  throw new Error('upload did not finish');
}

function parseComplete(body: Buffer): UploadReceipt {
  const value = parseJson(body);
  if (!value || typeof value !== 'object') throw new Error('upload did not finish');
  const record = value as Record<string, unknown>;
  if (record.status !== 'RECEIVED') throw new Error('upload did not finish');
  return parseReceipt(record.receipt);
}

async function getView(uploadUrl: URL, token: string): Promise<RemoteView> {
  const response = await exchange(uploadUrl, 'GET', token, null, null);
  if (response.status === 401 || response.status === 403) throw new Error('upload ticket was rejected');
  if (response.status !== 200) {
    if (RETRY_STATUS.has(response.status)) throw new Retryable('upload connection failed');
    throw new Error('upload endpoint returned an unreadable response');
  }
  const view = parseView(response.body);
  if (DEAD_STATUS.has(view.status)) throw new Error('upload ticket is no longer accepted');
  return view;
}

function parseView(body: Buffer): RemoteView {
  const value = parseJson(body);
  if (!value || typeof value !== 'object') throw new Error('upload endpoint returned an unreadable response');
  const record = value as Record<string, unknown>;
  if (record.receivedBytes !== undefined && record.status === undefined && record.files === undefined) {
    throw new Error('upload endpoint returned an unreadable response');
  }
  const status = record.status;
  if (typeof status !== 'string' || status.length < 1 || status.length > 40) {
    throw new Error('upload endpoint returned an unreadable response');
  }
  const filesValue = record.files;
  if (!Array.isArray(filesValue) || filesValue.length > MAX_FILES) {
    throw new Error('upload endpoint returned an unreadable response');
  }
  const files = filesValue.map(parseRemoteFile);
  const receipt = record.receipt === undefined ? undefined : parseReceipt(record.receipt);
  return { status, files, ...(receipt ? { receipt } : {}) };
}

function parseRemoteFile(value: unknown): RemoteFile {
  if (!value || typeof value !== 'object') throw new Error('upload endpoint returned an unreadable response');
  const record = value as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  const sha256 = record.sha256;
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('upload endpoint returned an unreadable response');
  if (typeof name !== 'string' || name.length < 1 || name.length > 200 || NAME_BAD.test(name)) {
    throw new Error('upload endpoint returned an unreadable response');
  }
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) throw new Error('upload endpoint returned an unreadable response');
  return {
    id,
    name,
    sha256,
    bytes: readCount(record.bytes),
    receivedBytes: readCount(record.receivedBytes),
  };
}

function parseReceived(body: Buffer): number {
  const value = parseJson(body);
  if (!value || typeof value !== 'object') throw new Error('upload endpoint returned an unreadable response');
  return readCount((value as { receivedBytes?: unknown }).receivedBytes);
}

function parseReceipt(value: unknown): UploadReceipt {
  if (!value || typeof value !== 'object') throw new Error('upload did not finish');
  const record = value as Record<string, unknown>;
  const id = record.id;
  const sha256 = record.sha256;
  const repoSha = record.repoSha;
  const receivedAt = record.receivedAt;
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('upload did not finish');
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) throw new Error('upload did not finish');
  if (typeof repoSha !== 'string' || !REPO_RE.test(repoSha)) throw new Error('upload did not finish');
  if (typeof receivedAt !== 'string' || receivedAt.length < 4 || receivedAt.length > 80) {
    throw new Error('upload did not finish');
  }
  return { id, sha256, repoSha, receivedAt };
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new Error('upload endpoint returned an unreadable response');
  }
}

function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('upload endpoint returned an unreadable response');
  }
  return value;
}

function allowedProtocol(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

type Exchange = { status: number; body: Buffer };

async function exchange(
  target: URL,
  method: string,
  token: string,
  body: Buffer | null,
  contentType: string | null,
): Promise<Exchange> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    Connection: 'close',
  };
  if (contentType) headers['Content-Type'] = contentType;
  if (body) headers['Content-Length'] = String(body.length);
  const options: RequestOptions = { method, headers, timeout: 120_000 };
  try {
    const response = await new Promise<Exchange>((resolve, reject) => {
      const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, options, (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new Error('upload endpoint returned a redirect'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE) {
            req.destroy();
            reject(new Error('upload endpoint returned an oversized response'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
        res.on('error', () => reject(new Retryable('upload connection failed')));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => reject(new Retryable('upload connection failed')));
      req.end(body ?? undefined);
    });
    return response;
  } catch (error) {
    if (error instanceof Retryable) throw error;
    if (error instanceof Error && (
      error.message === 'upload endpoint returned a redirect'
      || error.message === 'upload endpoint returned an oversized response'
      || error.message === 'upload URL is not allowed'
    )) {
      throw error;
    }
    throw new Retryable('upload connection failed');
  }
}
