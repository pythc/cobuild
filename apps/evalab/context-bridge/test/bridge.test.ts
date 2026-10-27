import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, unlink, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BridgeConfig } from '../src/config.ts';
import { setRemoteInvokerForTests } from '../src/remote.ts';
import { BRIDGE_INSTRUCTIONS, createBridgeServer } from '../src/server.ts';
import { makeTemp, writeCodex } from './helpers.ts';

const TOKEN = `lu_${'B'.repeat(43)}`;
const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';
const FILE_ID = '22222222-2222-4222-8222-222222222222';

test('submit_files streams raw bytes and does not return or forward contents', async () => {
  const temp = await makeTemp('assessment-bridge-');
  const calls: Array<{ name: string; args: unknown }> = [];
  const seen: Array<{ method: string; url: string; authorization?: string; body: Buffer }> = [];
  let stored = Buffer.alloc(0);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '';
      seen.push({
        method: req.method ?? '',
        url,
        authorization: req.headers.authorization,
        body,
      });
      if (req.method === 'POST' && url.endsWith('/manifest')) {
        const manifest = JSON.parse(body.toString('utf8')) as { files: Array<{ name: string; sha256: string; bytes: number; source: string; coverage: string }> };
        assert.equal(manifest.files[0]?.source, 'agent-export');
        assert.equal(manifest.files[0]?.coverage, 'export');
        json(res, {
          uploadId: UPLOAD_ID,
          status: 'UPLOADING',
          expiresAt: '2026-09-28T00:00:00.000Z',
          files: [{
            id: FILE_ID,
            name: manifest.files[0]?.name,
            sha256: manifest.files[0]?.sha256,
            bytes: manifest.files[0]?.bytes,
            receivedBytes: 0,
          }],
        });
        return;
      }
      if (req.method === 'PUT') {
        const offset = Number(new URL(url, 'http://127.0.0.1').searchParams.get('offset'));
        assert.equal(offset, stored.length);
        assert.equal(Number(req.headers['content-length']), body.length);
        assert.ok(body.length <= 4 * 1024 * 1024);
        stored = Buffer.concat([stored, body]);
        json(res, { receivedBytes: stored.length });
        return;
      }
      if (req.method === 'POST' && url.endsWith('/complete')) {
        assert.equal(body.toString('utf8'), '{}');
        json(res, {
          status: 'RECEIVED',
          receipt: {
            id: '44444444-4444-4444-8444-444444444444',
            sha256: 'ab'.repeat(32),
            repoSha: 'c'.repeat(40),
            receivedAt: '2026-09-28T00:00:00.000Z',
          },
        });
        return;
      }
      json(res, {
        uploadId: UPLOAD_ID,
        status: 'UPLOADING',
        expiresAt: '2026-09-28T00:00:00.000Z',
        files: [{ id: FILE_ID, name: 'match.jsonl', sha256: createHash('sha256').update(stored).digest('hex'), bytes: stored.length, receivedBytes: stored.length }],
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const origin = `http://127.0.0.1:${address.port}`;
  setRemoteInvokerForTests(async (_config, name, args) => {
    calls.push({ name, args });
    if (name === 'submit_materials') {
      return {
        uploadId: UPLOAD_ID,
        uploadUrl: `${origin}/material-uploads/${UPLOAD_ID}`,
        uploadToken: TOKEN,
        expiresAt: '2026-09-28T00:00:00.000Z',
        maxTotalBytes: 1073741824,
        chunkBytes: 4194304,
        helperUrl: `${origin}/downloads/upload-materials.py`,
        status: 'AWAITING_FILES',
        message: 'UNIQUE_TRANSCRIPT_SENTENCE should not be copied from this message',
      };
    }
    if (name === 'exam_status') return { state: 'NOT_STARTED' };
    if (name === 'test_connection') return { ok: true };
    throw new Error('unexpected tool');
  });
  try {
    const workspace = path.join(temp.dir, 'workspace');
    const root = path.join(temp.dir, 'root');
    await mkdir(workspace, { recursive: true });
    const source = path.join(root, 'match.jsonl');
    await writeCodex(source, workspace, 'UNIQUE_TRANSCRIPT_SENTENCE');
    const raw = await readFile(source);
    assert.match(raw.toString('utf8'), /SUPER_SECRET_SYSTEM_PROMPT/);
    const config: BridgeConfig = {
      assessmentUrl: origin,
      token: 'bridge-test-token-value',
      workspaceReal: workspace,
      contextRoots: [root],
      mcpPath: '/mcp',
    };
    const bridge = createBridgeServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await bridge.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['exam_status', 'find_candidate_files', 'submit_files', 'test_connection']);
    const descriptions = listed.tools.map((tool) => tool.description ?? '').join('\n');
    assert.doesNotMatch(descriptions, /prepare_local_bundle|preview_bundle_file|request_upload_approval|submit_approved_materials/);
    assert.doesNotMatch(BRIDGE_INSTRUCTIONS, /prepare_local_bundle|preview_bundle_file|request_upload_approval|submit_approved_materials/);
    assert.match(BRIDGE_INSTRUCTIONS, /Do not conceal/);
    assert.match(descriptions, /UPLOAD/);
    assert.match(descriptions, /cannot finalize/);
    assert.match(descriptions, /Do not conceal this upload/);
    const found = await client.callTool({ name: 'find_candidate_files', arguments: {} });
    const foundBody = JSON.parse(textOf(found)) as { candidates: Array<{ id: string }> };
    assert.equal(JSON.stringify(foundBody).includes(temp.dir), false);
    assert.doesNotMatch(textOf(found), /UNIQUE_TRANSCRIPT_SENTENCE|SUPER_SECRET_SYSTEM_PROMPT/);
    const fileId = foundBody.candidates[0]?.id;
    assert.ok(fileId);
    const uploaded = await client.callTool({
      name: 'submit_files',
      arguments: {
        fileIds: [fileId],
        repoSha: 'c'.repeat(40),
        projectSummary: 'Exam project summary.',
        collaborationSummary: 'A declared collaboration summary, not the transcript.',
        clients: [{ name: 'Codex CLI', models: [{ name: 'gpt-5.1', source: 'detected' }] }],
      },
    });
    const uploadedText = textOf(uploaded);
    const uploadedBody = JSON.parse(uploadedText) as { contentsSent: boolean; unchangedBytes: boolean; message: string; receipt: { id: string } };
    assert.equal(uploadedBody.contentsSent, true);
    assert.equal(uploadedBody.unchangedBytes, true);
    assert.match(uploadedBody.message, /did not finalize/);
    assert.match(uploadedBody.message, /not original conversation history/);
    assert.equal(uploadedBody.receipt.id, '44444444-4444-4444-8444-444444444444');
    assert.doesNotMatch(uploadedText, /UNIQUE_TRANSCRIPT_SENTENCE|SUPER_SECRET_SYSTEM_PROMPT|bridge-test-token-value/);
    assert.equal(uploadedText.includes(TOKEN), false);
    assert.equal(uploadedText.includes(temp.dir), false);
    assert.equal(stored.equals(raw), true);
    const submit = calls.find((call) => call.name === 'submit_materials');
    assert.ok(submit);
    assert.deepEqual(Object.keys(submit.args as object).sort(), ['clients', 'collaborationSummary', 'projectSummary', 'repoSha']);
    const forwarded = JSON.stringify(submit.args);
    assert.doesNotMatch(forwarded, /UNIQUE_TRANSCRIPT_SENTENCE|SUPER_SECRET_SYSTEM_PROMPT|sha256|uploadToken/);
    assert.equal(seen.some((item) => item.authorization === `Bearer ${TOKEN}`), true);
    assert.equal(seen.some((item) => item.authorization?.includes('bridge-test-token-value')), false);
    const status = JSON.parse(textOf(await client.callTool({ name: 'exam_status', arguments: {} }))) as { state: string };
    const probe = JSON.parse(textOf(await client.callTool({ name: 'test_connection', arguments: {} }))) as { ok: boolean };
    assert.equal(status.state, 'NOT_STARTED');
    assert.equal(probe.ok, true);
    await client.close();
    await bridge.close();
  } finally {
    setRemoteInvokerForTests(null);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await temp.cleanup();
  }
});

test('submit_files refuses a symlink that escapes the root', async () => {
  const temp = await makeTemp('assessment-bridge-link-');
  const calls: string[] = [];
  setRemoteInvokerForTests(async (_config, name) => {
    calls.push(name);
    return { state: 'NOT_STARTED' };
  });
  try {
    const workspace = path.join(temp.dir, 'workspace');
    const root = path.join(temp.dir, 'root');
    const outside = path.join(temp.dir, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    const source = path.join(root, 'match.jsonl');
    await writeCodex(source, workspace, 'UNIQUE_TRANSCRIPT_SENTENCE');
    const config: BridgeConfig = {
      assessmentUrl: 'http://127.0.0.1:9',
      token: 'bridge-test-token-value',
      workspaceReal: workspace,
      contextRoots: [root],
      mcpPath: '/mcp',
    };
    const bridge = createBridgeServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await bridge.connect(serverTransport);
    await client.connect(clientTransport);
    const found = JSON.parse(textOf(await client.callTool({ name: 'find_candidate_files', arguments: {} }))) as {
      candidates: Array<{ id: string }>;
    };
    const fileId = found.candidates[0]?.id;
    assert.ok(fileId);
    await writeFile(path.join(outside, 'secret.jsonl'), 'CANARY_OUTSIDE');
    await unlink(source);
    await symlink(path.join(outside, 'secret.jsonl'), source);
    const blocked = await client.callTool({
      name: 'submit_files',
      arguments: {
        fileIds: [fileId],
        repoSha: 'c'.repeat(40),
        projectSummary: 'Exam project summary.',
        collaborationSummary: 'Declared summary.',
        clients: [{ name: 'Codex CLI', models: [{ name: 'gpt-5.1', source: 'detected' }] }],
      },
    });
    assert.equal((blocked as { isError?: boolean }).isError, true);
    assert.doesNotMatch(textOf(blocked), /CANARY_OUTSIDE|UNIQUE_TRANSCRIPT_SENTENCE/);
    assert.equal(calls.includes('submit_materials'), false);
    await client.close();
    await bridge.close();
  } finally {
    setRemoteInvokerForTests(null);
    await temp.cleanup();
  }
});

function json(res: ServerResponse, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
  res.end(body);
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.find((item) => item.text)?.text;
  assert.ok(text);
  return text;
}
