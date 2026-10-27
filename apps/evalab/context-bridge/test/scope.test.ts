import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { forEachLine } from '../src/lines.ts';
import { assertSafeRoot, isContained, resolveInsideRoots } from '../src/scope.ts';
import { makeTemp } from './helpers.ts';

test('rejects filesystem root and the home directory as scan roots', () => {
  assert.throws(() => assertSafeRoot(realpathSync('/')), /too broad/);
  assert.throws(() => assertSafeRoot(realpathSync(homedir())), /too broad/);
});

test('containment rejects sibling prefixes and symlink escapes', async () => {
  const temp = await makeTemp('assessment-scope-');
  try {
    const root = path.join(temp.dir, 'root');
    const outside = path.join(temp.dir, 'outside');
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await mkdir(outside, { recursive: true });
    const inside = path.join(root, 'nested', 'note.txt');
    const secret = path.join(outside, 'secret.txt');
    await writeFile(inside, 'inside');
    await writeFile(secret, 'OUTSIDE_CANARY');
    await symlink(secret, path.join(root, 'escape.txt'));
    const rootReal = realpathSync(root);
    assert.equal(isContained(rootReal, realpathSync(inside)), true);
    assert.equal(isContained(rootReal, realpathSync(secret)), false);
    assert.equal(isContained(rootReal, rootReal + '-other'), false);
    assert.equal(await resolveInsideRoots([rootReal], 'nested/note.txt'), realpathSync(inside));
    assert.equal(await resolveInsideRoots([rootReal], 'nested/../../outside/secret.txt'), null);
    assert.equal(await resolveInsideRoots([rootReal], 'escape.txt'), null);
    assert.equal(await resolveInsideRoots([rootReal], secret), null);
  } finally {
    await temp.cleanup();
  }
});

test('line reader skips an oversized line and keeps the next line', async () => {
  const temp = await makeTemp('assessment-lines-');
  try {
    const file = path.join(temp.dir, 'notes.txt');
    await writeFile(file, `short\n${'x'.repeat(80)}\nkept\n`);
    const lines: string[] = [];
    await forEachLine(file, (line) => {
      lines.push(line);
    }, 20);
    assert.deepEqual(lines, ['short', 'kept']);
  } finally {
    await temp.cleanup();
  }
});
