import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, open, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertTicketUrl, assertUploadToken, boundedChunkBytes, uploadRawFiles, type UploadTicket } from '../src/directUpload.ts';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_CHUNK_BYTES } from '../src/limits.ts';
import { makeTemp } from './helpers.ts';

const TOKEN = `lu_${'C'.repeat(43)}`;
const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';

test('ticket url and token stay on https or loopback', () => {
  assert.throws(() => assertTicketUrl('https://exam.example', 'http://exam.example/material-uploads/11111111-1111-4111-8111-111111111111'));
  assert.throws(() => assertTicketUrl('http://127.0.0.1:9', 'http://203.0.113.1/material-uploads/11111111-1111-4111-8111-111111111111'));
  assert.throws(() => assertUploadToken('bridge-test-token-value'));
  assert.equal(boundedChunkBytes(MAX_UPLOAD_CHUNK_BYTES * 2), MAX_UPLOAD_CHUNK_BYTES);
  const allowed = assertTicketUrl('http://127.0.0.1:9', 'http://127.0.0.1:9/material-uploads/11111111-1111-4111-8111-111111111111');
  assert.equal(allowed.pathname, '/material-uploads/11111111-1111-4111-8111-111111111111');
});

test('upload resumes after an offset conflict and does not follow redirects', async () => {
  const temp = await makeTemp('assessment-upload-');
  const stealHits: string[] = [];
  const steal = createServer((req, res) => {
    stealHits.push(req.headers.authorization ?? '');
    res.end('no');
  });
  const puts: Array<{ offset: number; body: Buffer }> = [];
  let putCount = 0;
  const files = new Map<string, { name: string; sha256: string; bytes: number; body: Buffer }>();
  const upload = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '';
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401);
        res.end('{}');
        return;
      }
      if (req.method === 'POST' && url.endsWith('/manifest')) {
        const manifest = JSON.parse(body.toString('utf8')) as { files: Array<{ name: string; sha256: string; bytes: number }> };
        const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
        files.clear();
        manifest.files.forEach((file, index) => {
          files.set(ids[index] ?? '', { name: file.name, sha256: file.sha256, bytes: file.bytes, body: Buffer.alloc(0) });
        });
        json(res, view());
        return;
      }
      if (req.method === 'PUT') {
        putCount += 1;
        const parsed = new URL(url, 'http://127.0.0.1');
        const id = parsed.pathname.split('/').pop() ?? '';
        const offset = Number(parsed.searchParams.get('offset'));
        const file = files.get(id);
        puts.push({ offset, body });
        if (!file || offset !== file.body.length || putCount === 2) {
          json(res, { message: 'offset' }, 409);
          return;
        }
        file.body = Buffer.concat([file.body, body]);
        json(res, { receivedBytes: file.body.length });
        return;
      }
      if (req.method === 'POST' && url.endsWith('/complete')) {
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
      json(res, view());
    });
  });
  await listen(steal);
  await listen(upload);
  const stealPort = portOf(steal);
  const uploadPort = portOf(upload);
  try {
    const root = path.join(temp.dir, 'root');
    await mkdir(root);
    await writeFile(path.join(root, 'b.bin'), Buffer.from('BBB-marker'));
    await writeFile(path.join(root, 'a.bin'), Buffer.from('AAA-marker'));
    const ticket: UploadTicket = {
      uploadId: UPLOAD_ID,
      uploadUrl: `http://127.0.0.1:${uploadPort}/material-uploads/${UPLOAD_ID}`,
      uploadToken: TOKEN,
      maxTotalBytes: MAX_UPLOAD_BYTES,
      chunkBytes: 4,
    };
    const result = await uploadRawFiles({
      assessmentOrigin: `http://127.0.0.1:${uploadPort}`,
      roots: [root],
      files: [
        { fileReal: path.join(root, 'b.bin'), relativeName: 'nested/b.bin', coverage: 'export' },
        { fileReal: path.join(root, 'a.bin'), relativeName: 'a.bin', coverage: 'export' },
      ],
      openTicket: async () => ticket,
    });
    assert.equal(result.status, 'RECEIVED');
    const byName = new Map([...files.values()].map((file) => [file.name, file.body.toString('utf8')]));
    assert.equal(byName.get('nested__b.bin'), 'BBB-marker');
    assert.equal(byName.get('a.bin'), 'AAA-marker');
    assert.equal(puts[0]?.offset, 0);
    assert.ok(puts.some((item) => item.offset === 4));
    assert.equal(stealHits.length, 0);

    const redirect = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      res.writeHead(302, { Location: `http://127.0.0.1:${stealPort}/stolen`, 'content-length': '0' });
      res.end();
    });
    await listen(redirect);
    try {
      await assert.rejects(() => uploadRawFiles({
        assessmentOrigin: `http://127.0.0.1:${portOf(redirect)}`,
        roots: [root],
        files: [{ fileReal: path.join(root, 'a.bin'), relativeName: 'a.bin', coverage: 'export' }],
        openTicket: async () => ({
          ...ticket,
          uploadUrl: `http://127.0.0.1:${portOf(redirect)}/material-uploads/${UPLOAD_ID}`,
        }),
      }), /redirect/);
      assert.equal(stealHits.length, 0);
    } finally {
      await close(redirect);
    }
  } finally {
    await close(upload);
    await close(steal);
    await temp.cleanup();
  }

  function view() {
    return {
      uploadId: UPLOAD_ID,
      status: 'UPLOADING',
      expiresAt: '2026-09-28T00:00:00.000Z',
      files: [...files.entries()].map(([id, file]) => ({
        id,
        name: file.name,
        sha256: file.sha256,
        bytes: file.bytes,
        receivedBytes: file.body.length,
      })).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }
});

test('oversized and symlink files are rejected before a ticket is opened', async () => {
  const temp = await makeTemp('assessment-upload-guard-');
  try {
    const root = path.join(temp.dir, 'root');
    const outside = path.join(temp.dir, 'outside');
    await mkdir(root);
    await mkdir(outside);
    const huge = path.join(root, 'huge.bin');
    const handle = await open(huge, 'w');
    await handle.truncate(MAX_UPLOAD_BYTES + 1);
    await handle.close();
    let opened = false;
    const started = Date.now();
    await assert.rejects(() => uploadRawFiles({
      assessmentOrigin: 'http://127.0.0.1:9',
      roots: [root],
      files: [{ fileReal: huge, relativeName: 'huge.bin', coverage: 'export' }],
      openTicket: async () => {
        opened = true;
        throw new Error('ticket opened');
      },
    }), /1GiB/);
    assert.equal(opened, false);
    assert.ok(Date.now() - started < 2000);

    await writeFile(path.join(outside, 'secret.bin'), 'CANARY_OUTSIDE');
    const link = path.join(root, 'link.bin');
    await symlink(path.join(outside, 'secret.bin'), link);
    opened = false;
    await assert.rejects(() => uploadRawFiles({
      assessmentOrigin: 'http://127.0.0.1:9',
      roots: [root],
      files: [{ fileReal: link, relativeName: 'link.bin', coverage: 'export' }],
      openTicket: async () => {
        opened = true;
        throw new Error('ticket opened');
      },
    }));
    assert.equal(opened, false);
  } finally {
    await temp.cleanup();
  }
});

function json(res: ServerResponse, value: unknown, status = 200) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) });
  res.end(body);
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
}

function portOf(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
