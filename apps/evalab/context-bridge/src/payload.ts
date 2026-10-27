import { Buffer } from 'node:buffer';
import { canonicalJson, payloadHash, sha256Hex } from './canonical.js';
import {
  MAX_CLIENTS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_LABEL_CHARS,
  MAX_MODELS,
  MAX_PARAMETERS,
  MAX_PAYLOAD_BYTES,
  MAX_SUMMARY_CHARS,
} from './limits.js';
import { containsSecretMarker } from './redact.js';
import type { MaterialClient, MaterialPayload } from './types.js';

const NAME_BAD = /[\\/:\u0000-\u001f\u007f]/;
const SHA_RE = /^[a-f0-9]{64}$/;
const REPO_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PARAM_KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

export function assertPayloadCoherent(payload: MaterialPayload): string {
  if (payload.schemaVersion !== 1) throw new Error('payload schemaVersion must be 1');
  if (!REPO_RE.test(payload.repoSha)) throw new Error('repoSha must be a lowercase git SHA');
  if (payload.files.length === 0 || payload.files.length > MAX_FILES) {
    throw new Error('payload must contain 1 to 20 files');
  }
  if (payload.files.length !== payload.manifest.files.length) {
    throw new Error('manifest does not match file contents');
  }
  assertSummary(payload.manifest.projectSummary, 'projectSummary');
  assertSummary(payload.manifest.collaborationSummary, 'collaborationSummary');
  assertClients(payload.manifest.clients);
  const names = new Set<string>();
  let total = 0;
  for (let index = 0; index < payload.files.length; index += 1) {
    const file = payload.files[index];
    const meta = payload.manifest.files[index];
    if (!file || !meta || file.name !== meta.name) throw new Error('manifest does not match file contents');
    if (!fileNameAllowed(file.name)) throw new Error('file name is not allowed');
    if (names.has(file.name)) throw new Error('duplicate file name');
    names.add(file.name);
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes < 1 || bytes !== meta.bytes || bytes > MAX_FILE_BYTES) throw new Error('file size does not match the manifest');
    if (!SHA_RE.test(meta.sha256) || sha256Hex(file.content) !== meta.sha256) {
      throw new Error('file sha256 does not match the manifest');
    }
    if (meta.coverage !== 'export' && meta.coverage !== 'partial') throw new Error('coverage is invalid');
    if (containsSecretMarker(file.content) || containsSecretMarker(meta.source)) {
      throw new Error('payload still contains a secret marker');
    }
    total += bytes;
  }
  if (total > MAX_PAYLOAD_BYTES) throw new Error('payload exceeds 10MB');
  const encoded = canonicalJson(payload);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('payload exceeds 10MB');
  return payloadHash(payload);
}

function assertSummary(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > MAX_SUMMARY_CHARS) {
    throw new Error(`${label} length is invalid`);
  }
  if (containsSecretMarker(value)) throw new Error(`${label} contains a secret marker`);
}

function assertClients(clients: MaterialClient[]): void {
  if (clients.length < 1 || clients.length > MAX_CLIENTS) throw new Error('clients are required');
  for (const client of clients) {
    assertLabel(client.name, 'client name');
    if (client.version !== undefined) assertLabel(client.version, 'client version');
    if (client.models.length < 1 || client.models.length > MAX_MODELS) throw new Error('each client needs at least one model');
    for (const model of client.models) {
      assertLabel(model.name, 'model name');
      if (model.source !== 'reported' && model.source !== 'detected' && model.source !== 'unknown') {
        throw new Error('model source is invalid');
      }
      const parameters = model.parameters ?? {};
      const keys = Object.keys(parameters);
      if (keys.length > MAX_PARAMETERS) throw new Error('too many parameters');
      for (const key of keys) {
        if (!PARAM_KEY_RE.test(key)) throw new Error('parameter name is not allowed');
      }
    }
  }
}

function assertLabel(value: string, label: string): void {
  if (value.trim().length < 1 || value.length > MAX_LABEL_CHARS || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function fileNameAllowed(name: string): boolean {
  return name.length >= 1 && name.length <= 200 && name !== '.' && name !== '..' && !NAME_BAD.test(name);
}
