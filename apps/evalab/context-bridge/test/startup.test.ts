import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { makeTemp } from './helpers.ts';

const bridgeRoot = path.resolve(import.meta.dirname, '..');

test('startup does not write protocol traffic or the token', async () => {
  const temp = await makeTemp('assessment-start-');
  try {
    const workspace = path.join(temp.dir, 'workspace');
    await mkdir(workspace);
    const missing = await runBridge({
      ASSESSMENT_MCP_TOKEN: 'bridge-test-token-value',
      ASSESSMENT_WORKSPACE: workspace,
    });
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /ASSESSMENT_URL is required/);
    assert.doesNotMatch(missing.stderr, /bridge-test-token-value/);
    assert.equal(missing.stderr.includes(workspace), false);

    const ready = await runBridge({
      ASSESSMENT_URL: 'http://127.0.0.1:9',
      ASSESSMENT_MCP_TOKEN: 'bridge-test-token-value',
      ASSESSMENT_WORKSPACE: workspace,
      ASSESSMENT_CONTEXT_ROOTS: workspace,
    }, { killOn: /ready/ });
    assert.match(ready.stderr, /ready/);
    assert.equal(ready.stdout, '');
    assert.doesNotMatch(ready.stderr, /bridge-test-token-value/);
    assert.equal(ready.stderr.includes(workspace), false);
  } finally {
    await temp.cleanup();
  }
});

test('npm-style symlink starts the bridge', async () => {
  const temp = await makeTemp('assessment-bin-');
  try {
    const workspace = path.join(temp.dir, 'workspace');
    await mkdir(workspace);
    const entry = path.join(temp.dir, 'assessment-context-bridge');
    await symlink(path.join(bridgeRoot, 'src/index.ts'), entry);
    const ready = await runBridge({
      ASSESSMENT_URL: 'http://127.0.0.1:9',
      ASSESSMENT_MCP_TOKEN: 'bridge-test-token-value',
      ASSESSMENT_WORKSPACE: workspace,
    }, { entry, killOn: /ready/ });
    assert.match(ready.stderr, /ready/);
    assert.equal(ready.stdout, '');
  } finally {
    await temp.cleanup();
  }
});

function runBridge(
  env: Record<string, string>,
  options?: { killOn?: RegExp; entry?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', options?.entry ?? 'src/index.ts'], {
      cwd: bridgeRoot,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('bridge startup timed out'));
    }, 8000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (options?.killOn?.test(stderr)) child.kill('SIGTERM');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
