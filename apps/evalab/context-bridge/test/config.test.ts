import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { diag } from '../src/diag.ts';
import { loadConfig, splitContextRoots } from '../src/config.ts';
import { makeTemp } from './helpers.ts';

test('config requires an explicit workspace and rejects credential URLs and home', async () => {
  const temp = await makeTemp('assessment-config-');
  try {
    const workspace = path.join(temp.dir, 'workspace');
    await mkdir(workspace);
    await assert.rejects(
      () => loadConfig({ ASSESSMENT_URL: 'http://user:pw@127.0.0.1:9', ASSESSMENT_MCP_TOKEN: 'token-value', ASSESSMENT_WORKSPACE: workspace }),
      /credentials/,
    );
    await assert.rejects(
      () => loadConfig({ ASSESSMENT_MCP_TOKEN: 'token-value', ASSESSMENT_WORKSPACE: workspace }),
      /ASSESSMENT_URL is required/,
    );
    const home = process.env.HOME;
    assert.ok(home);
    await assert.rejects(
      () => loadConfig({
        ASSESSMENT_URL: 'http://127.0.0.1:9',
        ASSESSMENT_MCP_TOKEN: 'bridge-test-token-value',
        ASSESSMENT_WORKSPACE: home,
      }),
      /too broad/,
    );
    await assert.rejects(
      () => loadConfig({
        ASSESSMENT_URL: 'http://127.0.0.1:9/mcp',
        ASSESSMENT_MCP_TOKEN: 'bridge-test-token-value',
        ASSESSMENT_WORKSPACE: workspace,
      }),
      /path/,
    );
    await assert.rejects(
      () => loadConfig({
        ASSESSMENT_URL: 'http://47.109.176.127',
        ASSESSMENT_MCP_TOKEN: 'bridge-test-token-value',
        ASSESSMENT_WORKSPACE: workspace,
      }),
      /https/,
    );
    const extra = path.join(temp.dir, 'extra');
    await mkdir(extra);
    const config = await loadConfig({
      ASSESSMENT_URL: 'https://47.109.176.127',
      ASSESSMENT_MCP_TOKEN: 'bridge-test-token-value',
      ASSESSMENT_WORKSPACE: workspace,
      ASSESSMENT_CONTEXT_ROOTS: JSON.stringify([extra]),
    });
    assert.equal(config.assessmentUrl, 'https://47.109.176.127');
    assert.deepEqual(config.contextRoots, [workspace, extra]);
    assert.equal(JSON.stringify(config).includes('bridge-test-token-value'), true);
    assert.deepEqual(splitContextRoots('C:\\exam\\sessions;D:\\other', ';'), ['C:\\exam\\sessions', 'D:\\other']);
    assert.deepEqual(splitContextRoots('C:\\exam\\sessions', ';'), ['C:\\exam\\sessions']);
    assert.deepEqual(splitContextRoots('/tmp/a:/tmp/b\n/tmp/c'), ['/tmp/a', '/tmp/b', '/tmp/c']);
  } finally {
    await temp.cleanup();
  }
});

test('diagnostics drop paths and secrets', () => {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    diag('ready');
    diag(`token sk-abcdefghijklmnopqrstuvwxyz012345 in ${path.join('/tmp', 'secret')}`);
  } finally {
    process.stderr.write = original;
  }
  assert.match(lines[0] ?? '', /ready/);
  assert.match(lines[1] ?? '', /redacted/);
  assert.doesNotMatch(lines.join('\n'), /sk-abcdefghijklmnopqrstuvwxyz012345/);
});
