import { CanonicalError, HttpError } from './errors.js';
import { assertNoSecretMarker, canonicalJson, hashCanonical, sha256Hex } from './security.js';

const MB = 1024 * 1024;
const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,79}$/;
const NAME_BAD = /[\\/:\u0000-\u001f\u007f]/;

export type MaterialManifest = {
  files: Array<{
    name: string;
    sha256: string;
    bytes: number;
    source: string;
    coverage: 'export' | 'partial';
  }>;
  clients: Array<{
    name: string;
    version?: string;
    models: Array<{
      name: string;
      parameters?: Record<string, string | number | boolean | null>;
      source: 'reported' | 'detected' | 'unknown';
    }>;
  }>;
  projectSummary: string;
  collaborationSummary: string;
};

export type MaterialPayload = {
  schemaVersion: 1;
  repoSha: string;
  manifest: MaterialManifest;
  files: Array<{ name: string; content: string }>;
};

export type PreparedManifest = {
  manifest: MaterialManifest;
  payloadHash: string;
  repoSha: string;
};

export type CheckedPayload = {
  payload: MaterialPayload;
  sha256: string;
  clientCount: number;
  fileCount: number;
  coverage: 'export' | 'partial' | 'mixed';
};

export function validatePrepareInput(input: {
  manifest: unknown;
  payloadHash: string;
  repoSha: string;
}): PreparedManifest {
  const manifest = readManifest(input.manifest);
  if (!/^[a-f0-9]{64}$/i.test(input.payloadHash)) {
    throw new HttpError(400, '材料摘要格式不正确', 'VALIDATION');
  }
  return {
    manifest,
    payloadHash: input.payloadHash.toLowerCase(),
    repoSha: normalizeSha(input.repoSha),
  };
}

export function validateSubmitPayload(payload: unknown): CheckedPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, '材料格式不正确', 'VALIDATION');
  }
  const record = payload as Record<string, unknown>;
  assertKeys(record, ['schemaVersion', 'repoSha', 'manifest', 'files']);
  if (record.schemaVersion !== 1) throw new HttpError(400, '材料版本不受支持', 'VALIDATION');
  const manifest = readManifest(record.manifest);
  const files = readFiles(record.files, manifest);
  const normalized: MaterialPayload = {
    schemaVersion: 1,
    repoSha: normalizeSha(String(record.repoSha ?? '')),
    manifest,
    files,
  };
  let canonical: string;
  try {
    canonical = canonicalJson(normalized);
  } catch (error) {
    if (error instanceof CanonicalError) throw new HttpError(400, '材料格式不正确', 'VALIDATION');
    throw error;
  }
  if (Buffer.byteLength(canonical) > 10 * MB) {
    throw new HttpError(400, '材料超过 10MB 限制', 'VALIDATION');
  }
  const coverage = coverageOf(manifest.files.map((file) => file.coverage));
  return {
    payload: normalized,
    sha256: sha256Hex(canonical),
    clientCount: manifest.clients.length,
    fileCount: files.length,
    coverage,
  };
}

export function hashPayload(payload: MaterialPayload): string {
  return hashCanonical(payload);
}

function readManifest(value: unknown): MaterialManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '材料清单格式不正确', 'VALIDATION');
  }
  const record = value as Record<string, unknown>;
  assertKeys(record, ['files', 'clients', 'projectSummary', 'collaborationSummary']);
  const projectSummary = readSummary(record.projectSummary);
  const collaborationSummary = readSummary(record.collaborationSummary);
  const filesRaw = expectArray(record.files, 1, 20, 'files');
  const clientsRaw = expectArray(record.clients, 1, 30, 'clients');
  const files = filesRaw.map((item) => readManifestFile(item));
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (names.has(file.name)) throw new HttpError(400, '材料文件名重复', 'VALIDATION');
    names.add(file.name);
    total += file.bytes;
  }
  if (total > 10 * MB) throw new HttpError(400, '材料超过 10MB 限制', 'VALIDATION');
  return {
    files,
    clients: clientsRaw.map((item) => readClient(item)),
    projectSummary,
    collaborationSummary,
  };
}

function readManifestFile(value: unknown): MaterialManifest['files'][number] {
  const record = expectRecord(value, ['name', 'sha256', 'bytes', 'source', 'coverage']);
  const name = readFileName(record.name);
  const sha256 = typeof record.sha256 === 'string' ? record.sha256.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new HttpError(400, '文件摘要格式不正确', 'VALIDATION');
  const bytes = record.bytes;
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > MB) {
    throw new HttpError(400, '文件大小不正确', 'VALIDATION');
  }
  const source = typeof record.source === 'string' ? record.source : '';
  if (!SOURCE_RE.test(source) || source.includes('..')) {
    throw new HttpError(400, '文件来源只能是不含路径的短标签', 'VALIDATION');
  }
  if (record.coverage !== 'export' && record.coverage !== 'partial') {
    throw new HttpError(400, '覆盖范围不正确', 'VALIDATION');
  }
  assertNoSecretMarker(`${name}\n${source}`);
  return { name, sha256, bytes, source, coverage: record.coverage };
}

function readClient(value: unknown): MaterialManifest['clients'][number] {
  const record = expectRecord(value, ['name', 'version', 'models'], ['version']);
  const name = readLabel(record.name, '客户端名称');
  const models = expectArray(record.models, 1, 20, 'models').map((item) => readModel(item));
  const client: MaterialManifest['clients'][number] = { name, models };
  if (record.version !== undefined) client.version = readLabel(record.version, '客户端版本');
  assertNoSecretMarker(`${name}\n${client.version ?? ''}`);
  return client;
}

function readModel(value: unknown): MaterialManifest['clients'][number]['models'][number] {
  const record = expectRecord(value, ['name', 'parameters', 'source'], ['parameters']);
  const name = readLabel(record.name, '模型名称');
  if (record.source !== 'reported' && record.source !== 'detected' && record.source !== 'unknown') {
    throw new HttpError(400, '模型来源不正确', 'VALIDATION');
  }
  const model: MaterialManifest['clients'][number]['models'][number] = { name, source: record.source };
  if (record.parameters === null) throw new HttpError(400, '模型参数不正确', 'VALIDATION');
  if (record.parameters !== undefined) {
    model.parameters = readParameters(record.parameters);
  }
  assertNoSecretMarker(name);
  return model;
}

function readParameters(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '模型参数不正确', 'VALIDATION');
  }
  const record = expectRecord(value, Object.keys(value));
  const keys = Object.keys(record);
  if (keys.length > 20) throw new HttpError(400, '模型参数过多', 'VALIDATION');
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) throw new HttpError(400, '模型参数名称不正确', 'VALIDATION');
    const item = record[key];
    if (typeof item === 'string') {
      if (item.length > 500) throw new HttpError(400, '模型参数过长', 'VALIDATION');
      assertNoSecretMarker(item);
      out[key] = item;
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new HttpError(400, '模型参数不正确', 'VALIDATION');
      out[key] = item;
    } else if (typeof item === 'boolean' || item === null) {
      out[key] = item;
    } else {
      throw new HttpError(400, '模型参数不正确', 'VALIDATION');
    }
  }
  return out;
}

function readFiles(value: unknown, manifest: MaterialManifest): MaterialPayload['files'] {
  const rows = expectArray(value, 1, 20, 'files');
  if (rows.length !== manifest.files.length) {
    throw new HttpError(400, '材料文件与清单不一致', 'VALIDATION');
  }
  return rows.map((item, index) => {
    const record = expectRecord(item, ['name', 'content']);
    const name = readFileName(record.name);
    const expected = manifest.files[index];
    if (!expected || expected.name !== name) throw new HttpError(400, '材料文件与清单不一致', 'VALIDATION');
    if (typeof record.content !== 'string' || record.content.trim().length === 0) {
      throw new HttpError(400, '缺少真实的历史或文件内容', 'VALIDATION');
    }
    assertWellFormed(record.content);
    const bytes = Buffer.byteLength(record.content);
    if (bytes !== expected.bytes || bytes > MB) throw new HttpError(400, '文件大小与清单不一致', 'VALIDATION');
    if (sha256Hex(record.content) !== expected.sha256) {
      throw new HttpError(400, '文件摘要与内容不一致', 'VALIDATION');
    }
    assertNoSecretMarker(record.content);
    return { name, content: record.content };
  });
}

function readSummary(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 20000) {
    throw new HttpError(400, '摘要不能为空', 'VALIDATION');
  }
  assertNoSecretMarker(value);
  return value;
}

function readFileName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || NAME_BAD.test(value) || value === '.' || value === '..') {
    throw new HttpError(400, '文件名不能是路径', 'VALIDATION');
  }
  return value;
}

function readLabel(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 120 || /[\u0000-\u001f]/.test(value)) {
    throw new HttpError(400, `${label}不正确`, 'VALIDATION');
  }
  return value.trim();
}

function expectArray(value: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new HttpError(400, `${label}数量不正确`, 'VALIDATION');
  }
  return value;
}

function expectRecord(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '材料格式不正确', 'VALIDATION');
  }
  const record = value as Record<string, unknown>;
  assertKeys(record, keys, optional);
  return record;
}

function assertKeys(record: Record<string, unknown>, allowed: string[], optional: string[] = []): void {
  const ok = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!ok.has(key)) throw new HttpError(400, '材料包含未声明的字段', 'VALIDATION');
    if (record[key] === undefined && !optional.includes(key)) {
      throw new HttpError(400, '材料格式不正确', 'VALIDATION');
    }
  }
  for (const key of allowed) {
    if (!optional.includes(key) && !Object.hasOwn(record, key)) {
      throw new HttpError(400, '材料格式不正确', 'VALIDATION');
    }
  }
}

function coverageOf(values: Array<'export' | 'partial'>): 'export' | 'partial' | 'mixed' {
  const kinds = new Set(values);
  if (kinds.size === 1) return values[0] ?? 'partial';
  return 'mixed';
}

function normalizeSha(value: string): string {
  const sha = value.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha) && !/^[0-9a-f]{64}$/.test(sha)) {
    throw new HttpError(400, '提交 SHA 不正确', 'VALIDATION');
  }
  return sha;
}

function assertWellFormed(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new HttpError(400, '文件编码不正确', 'VALIDATION');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new HttpError(400, '文件编码不正确', 'VALIDATION');
    }
  }
}

export function displayManifest(value: unknown): MaterialManifest {
  try {
    return readManifest(value);
  } catch {
    return { files: [], clients: [], projectSummary: '', collaborationSummary: '' };
  }
}
