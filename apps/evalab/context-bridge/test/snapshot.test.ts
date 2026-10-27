import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, mkdir, mkdtemp, open, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { uploadRawFiles, type UploadTicket } from '../src/directUpload.ts';
import { MAX_UPLOAD_BYTES } from '../src/limits.ts';
import { makeTemp } from './helpers.ts';

// Each test process owns its scratch root; never inspect or tamper with another upload's snapshots.
const originalTmpdir = process.env.TMPDIR;
let scratchRoot = '';
before(async () => { scratchRoot = await mkdtemp(path.join(tmpdir(), 'bridge-snapshot-tests-')); process.env.TMPDIR = scratchRoot; });
after(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
  if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true });
});

const TOKEN = `lu_${'D'.repeat(43)}`;
const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';
const FILE_ID = '22222222-2222-4222-8222-222222222222';
const RECEIPT = {
  id: '44444444-4444-4444-8444-444444444444',
  sha256: 'ab'.repeat(32),
  repoSha: 'c'.repeat(40),
  receivedAt: '2026-09-28T00:00:00.000Z',
};

type Remote = { name: string; sha256: string; bytes: number; body: Buffer };

type Session = {
  files: Map<string, Remote>;
  conflict: boolean;
  failManifest: boolean;
  onManifest?: () => void;
  manifest?: Array<{ name: string; sha256: string; bytes: number; coverage?: string }>;
};

test.describe('raw byte snapshots', { concurrency: false }, () => {
  test('snapshot uploads exact binary bytes and leaves the source unchanged', async () => {
    const temp = await makeTemp('assessment-upload-snap-');
    const session = emptySession();
    const upload = mockServer(session);
    await listen(upload);
    try {
      const root = path.join(temp.dir, 'root');
      await mkdir(root);
      const raw = Buffer.concat([
        Buffer.from('line\r\n'),
        Buffer.from([0xff, 0x00, 0x0d, 0x0a]),
        Buffer.from('BODYMARKER9f3a\r\n'),
        Buffer.from('tail\r\n'),
      ]);
      const note = Buffer.from('other\r\n');
      const logPath = path.join(root, 'session.log');
      const notePath = path.join(root, 'note.bin');
      await writeFile(logPath, raw);
      await writeFile(notePath, note);
      const beforeLog = readFileSync(logPath);
      const beforeNote = readFileSync(notePath);
      const ticket = ticketFor(portOf(upload));
      let announced = 0;
      const result = await uploadRawFiles({
        assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
        roots: [root],
        files: [
          { fileReal: logPath, relativeName: 'nested/session.log', coverage: 'export' },
          { fileReal: notePath, relativeName: 'note.bin', coverage: 'export' },
        ],
        snapshotSource: true,
        openTicket: async (total) => {
          announced = total;
          return ticket;
        },
      });
      assert.equal(result.status, 'RECEIVED');
      assert.equal(announced, raw.length + note.length);
      assert.deepEqual(readFileSync(logPath), beforeLog);
      assert.deepEqual(readFileSync(notePath), beforeNote);
      const byName = new Map([...session.files.values()].map((file) => [file.name, file]));
      const uploaded = byName.get('nested__session.log');
      assert.ok(uploaded);
      assert.deepEqual(uploaded.body, raw);
      assert.equal(uploaded.sha256, sha256(raw));
      assert.equal(uploaded.bytes, raw.length);
      assert.deepEqual(byName.get('note.bin')?.body, note);
      assert.equal(session.manifest?.find((file) => file.name === 'nested__session.log')?.coverage, 'export');
      assert.equal(result.files.find((file) => file.name === 'nested__session.log')?.sha256, sha256(raw));
      assert.equal(readdirSync(tmpdir()).some((name) => name.startsWith('assessment-snap-')), false);
    } finally {
      await close(upload);
      await temp.cleanup();
    }
  });

  test('append after capture is excluded and the strict default still rejects it', async () => {
    const temp = await makeTemp('assessment-upload-grow-');
    const session = emptySession();
    const upload = mockServer(session);
    await listen(upload);
    try {
      const root = path.join(temp.dir, 'root');
      await mkdir(root);
      const source = path.join(root, 'active.log');
      const original = Buffer.from('prefix\r\n\xff');
      const extra = Buffer.from('\nAPPENDED-TAIL');
      await writeFile(source, original);
      const ticket = ticketFor(portOf(upload));
      const base = {
        assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
        roots: [root],
        files: [{ fileReal: source, relativeName: 'active.log', coverage: 'export' as const }],
      };
      session.onManifest = () => {
        writeFileSync(source, Buffer.concat([readFileSync(source), extra]));
      };
      const snapped = await uploadRawFiles({
        ...base,
        snapshotSource: true,
        openTicket: async () => ticket,
      });
      assert.equal(snapped.files[0]?.sha256, sha256(original));
      assert.equal(snapped.files[0]?.bytes, original.length);
      assert.deepEqual(session.files.get(FILE_ID)?.body, original);
      assert.deepEqual(readFileSync(source), Buffer.concat([original, extra]));

      await writeFile(source, original);
      session.files.clear();
      session.manifest = undefined;
      session.onManifest = () => {
        writeFileSync(source, Buffer.concat([readFileSync(source), extra]));
      };
      await assert.rejects(() => uploadRawFiles({
        ...base,
        openTicket: async () => ticket,
      }), /file changed while sending/);
      assert.deepEqual(readFileSync(source), Buffer.concat([original, extra]));
      assert.notDeepEqual(session.files.get(FILE_ID)?.body, Buffer.concat([original, extra]));
    } finally {
      await close(upload);
      await temp.cleanup();
    }
  });

  test('capture accepts an append and rejects truncation, rewrite, and replacement', async () => {
    const temp = await makeTemp('assessment-upload-race-');
    const session = emptySession();
    const upload = mockServer(session);
    await listen(upload);
    try {
      const root = path.join(temp.dir, 'root');
      await mkdir(root);
      const source = path.join(root, 'active.log');
      const original = Buffer.from('AAAA\r\n\xff\x00BBBB');
      await writeFile(source, original);
      const ticket = ticketFor(portOf(upload));
      let opened = false;
      await withFirstRead(source, async () => {
        await appendFile(source, '\nGROW');
      }, async () => {
        const result = await uploadRawFiles({
          assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
          roots: [root],
          files: [{ fileReal: source, relativeName: 'active.log', coverage: 'export' }],
          snapshotSource: true,
          openTicket: async () => {
            opened = true;
            return ticket;
          },
        });
        assert.equal(result.files[0]?.sha256, sha256(original));
        assert.deepEqual(session.files.get(FILE_ID)?.body, original);
      });
      assert.equal(opened, true);
      assert.deepEqual(readFileSync(source), Buffer.concat([original, Buffer.from('\nGROW')]));

      await writeFile(source, original);
      session.files.clear();
      opened = false;
      await withFirstRead(source, async () => {
        const handle = await open(source, 'r+');
        await handle.write(Buffer.from('Z'), 0, 1, 0);
        await handle.close();
      }, async () => {
        await assert.rejects(() => uploadRawFiles({
          assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
          roots: [root],
          files: [{ fileReal: source, relativeName: 'active.log', coverage: 'export' }],
          snapshotSource: true,
          openTicket: async () => {
            opened = true;
            throw new Error('ticket opened');
          },
        }), /capturing/);
      });
      assert.equal(opened, false);
      assert.equal(readFileSync(source)[0], 'Z'.charCodeAt(0));

      await writeFile(source, original);
      opened = false;
      await withFirstRead(source, async () => {
        await truncate(source, 0);
      }, async () => {
        await assert.rejects(() => uploadRawFiles({
          assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
          roots: [root],
          files: [{ fileReal: source, relativeName: 'active.log', coverage: 'export' }],
          snapshotSource: true,
          openTicket: async () => {
            opened = true;
            throw new Error('ticket opened');
          },
        }), /capturing/);
      });
      assert.equal(opened, false);
      assert.equal(readFileSync(source).length, 0);

      await writeFile(source, original);
      opened = false;
      await withFirstRead(source, async () => {
        const replacement = path.join(root, 'other.log');
        await writeFile(replacement, Buffer.from('YYYY'));
        await rename(replacement, source);
      }, async () => {
        await assert.rejects(() => uploadRawFiles({
          assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
          roots: [root],
          files: [{ fileReal: source, relativeName: 'active.log', coverage: 'export' }],
          snapshotSource: true,
          openTicket: async () => {
            opened = true;
            throw new Error('ticket opened');
          },
        }), /capturing/);
      });
      assert.equal(opened, false);
      assert.deepEqual(readFileSync(source), Buffer.from('YYYY'));
      assert.equal(readdirSync(tmpdir()).some((name) => name.startsWith('assessment-snap-')), false);
    } finally {
      await close(upload);
      await temp.cleanup();
    }
  });

  test('snapshot enforces limits before a ticket and removes temps after a failed upload', async () => {
    const temp = await makeTemp('assessment-upload-guard-snap-');
    const session = emptySession();
    session.failManifest = true;
    const modes: number[] = [];
    session.onManifest = () => {
      for (const name of readdirSync(tmpdir())) {
        if (!name.startsWith('assessment-snap-')) continue;
        collectModes(path.join(tmpdir(), name), modes);
      }
    };
    const upload = mockServer(session);
    await listen(upload);
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
        assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
        roots: [root],
        files: [{ fileReal: huge, relativeName: 'huge.bin', coverage: 'export' }],
        snapshotSource: true,
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
        assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
        roots: [root],
        files: [{ fileReal: link, relativeName: 'link.bin', coverage: 'export' }],
        snapshotSource: true,
        openTicket: async () => {
          opened = true;
          throw new Error('ticket opened');
        },
      }));
      assert.equal(opened, false);

      const secret = path.join(root, '.env');
      await writeFile(secret, 'SECRETTEXT');
      opened = false;
      await assert.rejects(() => uploadRawFiles({
        assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
        roots: [root],
        files: [{ fileReal: secret, relativeName: '.env', coverage: 'export' }],
        snapshotSource: true,
        openTicket: async () => {
          opened = true;
          throw new Error('ticket opened');
        },
      }));
      assert.equal(opened, false);

      const note = path.join(root, 'note.bin');
      await writeFile(note, Buffer.from('abc\r\n'));
      await assert.rejects(() => uploadRawFiles({
        assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
        roots: [root],
        files: [{ fileReal: note, relativeName: 'note.bin', coverage: 'export' }],
        snapshotSource: true,
        openTicket: async () => ticketFor(portOf(upload)),
      }));
      assert.ok(modes.includes(0o700));
      assert.ok(modes.includes(0o600));
      assert.ok(modes.every((mode) => mode === 0o700 || mode === 0o600));
      assert.equal(readdirSync(tmpdir()).some((name) => name.startsWith('assessment-snap-')), false);
      assert.deepEqual(readFileSync(note), Buffer.from('abc\r\n'));
    } finally {
      await close(upload);
      await temp.cleanup();
    }
  });

  test('a changed capture conflicts instead of replacing the ticket manifest', async () => {
    const temp = await makeTemp('assessment-upload-conflict-');
    const session = emptySession();
    session.conflict = true;
    session.files.set(FILE_ID, {
      name: 'active.log',
      sha256: 'ab'.repeat(32),
      bytes: 4,
      body: Buffer.from('KEEP'),
    });
    const upload = mockServer(session);
    await listen(upload);
    try {
      const root = path.join(temp.dir, 'root');
      await mkdir(root);
      const source = path.join(root, 'active.log');
      await writeFile(source, Buffer.from('NEXT\r\n'));
      const started = Date.now();
      await assert.rejects(() => uploadRawFiles({
        assessmentOrigin: `http://127.0.0.1:${portOf(upload)}`,
        roots: [root],
        files: [{ fileReal: source, relativeName: 'active.log', coverage: 'export' }],
        snapshotSource: true,
        openTicket: async () => ticketFor(portOf(upload)),
      }), /conflict/);
      assert.ok(Date.now() - started < 3000);
      assert.deepEqual(session.files.get(FILE_ID)?.body, Buffer.from('KEEP'));
      assert.equal(session.files.get(FILE_ID)?.sha256, 'ab'.repeat(32));
      assert.equal(session.manifest, undefined);
    } finally {
      await close(upload);
      await temp.cleanup();
    }
  });
});

function emptySession(): Session {
  return { files: new Map(), conflict: false, failManifest: false };
}

function ticketFor(port: number): UploadTicket {
  return {
    uploadId: UPLOAD_ID,
    uploadUrl: `http://127.0.0.1:${port}/material-uploads/${UPLOAD_ID}`,
    uploadToken: TOKEN,
    maxTotalBytes: MAX_UPLOAD_BYTES,
    chunkBytes: 4,
  };
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function mockServer(session: Session) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '';
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        json(res, { message: 'no' }, 401);
        return;
      }
      if (req.method === 'POST' && url.endsWith('/manifest')) {
        session.onManifest?.();
        if (session.failManifest) {
          json(res, { message: `${TOKEN} BODYMARKER9f3a` }, 400);
          return;
        }
        const manifest = JSON.parse(body.toString('utf8')) as {
          files: Array<{ name: string; sha256: string; bytes: number; coverage?: string }>;
        };
        if (session.conflict && session.files.size > 0) {
          const same = manifest.files.length === session.files.size && manifest.files.every((file) => {
            const current = [...session.files.values()].find((item) => item.name === file.name);
            return current?.sha256 === file.sha256 && current.bytes === file.bytes;
          });
          if (!same) {
            json(res, { code: 'UPLOAD_INVALID', message: `${TOKEN} BODYMARKER9f3a` }, 409);
            return;
          }
          json(res, view(session));
          return;
        }
        session.manifest = manifest.files;
        session.files.clear();
        manifest.files.forEach((file, index) => {
          const id = index === 0 ? FILE_ID : '33333333-3333-4333-8333-333333333333';
          session.files.set(id, { name: file.name, sha256: file.sha256, bytes: file.bytes, body: Buffer.alloc(0) });
        });
        json(res, view(session));
        return;
      }
      if (req.method === 'PUT') {
        const parsed = new URL(url, 'http://127.0.0.1');
        const id = parsed.pathname.split('/').pop() ?? '';
        const offset = Number(parsed.searchParams.get('offset'));
        const file = session.files.get(id);
        if (!file || offset !== file.body.length) {
          json(res, { message: 'offset' }, 409);
          return;
        }
        file.body = Buffer.concat([file.body, body]);
        json(res, { receivedBytes: file.body.length });
        return;
      }
      if (req.method === 'POST' && url.endsWith('/complete')) {
        json(res, { status: 'RECEIVED', receipt: RECEIPT });
        return;
      }
      json(res, view(session));
    });
  });
}

function view(session: Session) {
  return {
    uploadId: UPLOAD_ID,
    status: session.files.size ? 'UPLOADING' : 'AWAITING_FILES',
    expiresAt: '2026-09-28T00:00:00.000Z',
    files: [...session.files.entries()].map(([id, file]) => ({
      id,
      name: file.name,
      sha256: file.sha256,
      bytes: file.bytes,
      receivedBytes: file.body.length,
    })).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function collectModes(dir: string, modes: number[]) {
  const listed = lstatSync(dir);
  if (listed.isSymbolicLink()) throw new Error('snapshot symlink');
  modes.push(listed.mode & 0o777);
  if (!listed.isDirectory()) return;
  for (const name of readdirSync(dir)) collectModes(path.join(dir, name), modes);
}

async function withFirstRead(source: string, afterFirst: () => Promise<void>, body: () => Promise<void>) {
  const probe = await open(source, 'r');
  const proto = Object.getPrototypeOf(probe) as { read: (this: unknown, ...args: unknown[]) => Promise<unknown> };
  await probe.close();
  const original = proto.read;
  let armed = true;
  proto.read = async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args);
    if (armed) {
      armed = false;
      await afterFirst();
    }
    return result;
  };
  try {
    await body();
  } finally {
    proto.read = original;
  }
}

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
