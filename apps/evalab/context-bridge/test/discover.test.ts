import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildBundle } from '../src/bundle.ts';
import { canonicalJson, payloadHash, sha256Hex } from '../src/canonical.ts';
import { discover } from '../src/discover.ts';
import { containsSecretMarker } from '../src/redact.ts';
import { makeTemp, writeCodex } from './helpers.ts';

test('auto scan matches workspace Codex files and does not follow symlinks', async () => {
  const temp = await makeTemp('assessment-discover-');
  try {
    const workspace = path.join(temp.dir, 'workspace');
    const root = path.join(temp.dir, 'root');
    const outside = path.join(temp.dir, 'outside');
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(outside, 'nested'), { recursive: true });
    await writeCodex(path.join(root, 'sessions', 'match.jsonl'), workspace, 'UNIQUE_TRANSCRIPT_SENTENCE');
    await writeCodex(path.join(root, 'sessions', 'other.jsonl'), path.join(temp.dir, 'elsewhere'), 'OTHER_PROJECT');
    await writeCodex(path.join(outside, 'secret.jsonl'), workspace, 'CANARY_OUTSIDE');
    await writeCodex(path.join(outside, 'nested', 'secret-session.jsonl'), workspace, 'CANARY_DIR_LINK');
    await symlink(path.join(outside, 'secret.jsonl'), path.join(root, 'sessions', 'link.jsonl'));
    await symlink(path.join(outside, 'nested'), path.join(root, 'linked'));
    await writeFile(path.join(root, 'README.md'), '# Notes\n\nNot a chat.\n');

    const found = await discover({ roots: [root], workspaceReal: workspace });
    const serialized = JSON.stringify(found.candidates);
    assert.deepEqual(found.candidates.map((item) => item.relativeName), ['sessions/match.jsonl']);
    assert.equal(found.candidates[0]?.workspaceMatched, true);
    assert.equal(found.candidates[0]?.kind, 'codex-jsonl');
    assert.doesNotMatch(serialized, /CANARY_OUTSIDE|CANARY_DIR_LINK|OTHER_PROJECT/);
    assert.equal(serialized.includes(temp.dir), false);
    assert.equal(found.unsupported.length, 0);

    const selected = await discover({
      roots: [root],
      workspaceReal: workspace,
      explicitPaths: [
        'sessions/link.jsonl',
        'sessions/../../outside/secret.jsonl',
        'README.md',
        '.env',
        'state.vscdb',
      ],
    });
    assert.equal(selected.candidates.length, 1);
    assert.equal(selected.unsupported.length, 4);
    assert.match(selected.unsupported.map((item) => item.reason).join('\n'), /unsupported_export/);
    assert.equal(JSON.stringify({candidates: selected.candidates, unsupported: selected.unsupported, warnings: selected.warnings}).includes(temp.dir), false);
  } finally {
    await temp.cleanup();
  }
});

test('user-selected Cursor export is partial history and random text is unsupported', async () => {
  const temp = await makeTemp('assessment-cursor-');
  try {
    const root = path.join(temp.dir, 'root');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'chat.md'), [
      '# Cursor conversation export',
      '',
      '**User**',
      '',
      'How do I test this?',
      '',
      '**System**',
      '',
      'HIDDEN_SYSTEM_RULE',
      '',
      '**Cursor**',
      '',
      'Run the suite.',
      '',
    ].join('\n'));
    const found = await discover({
      roots: [root],
      workspaceReal: root,
      explicitPaths: ['chat.md', 'missing.md'],
    });
    assert.equal(found.candidates.length, 1);
    assert.equal(found.candidates[0]?.kind, 'cursor-export');
    assert.equal(found.candidates[0]?.selection, 'user-selected');
    assert.equal(found.unsupported.length, 1);
    const bundle = await buildBundle({
      candidates: found.catalog,
      workspaceReal: root,
      repoSha: 'a'.repeat(40),
      projectSummary: 'A small exam project.',
      collaborationSummary: 'The user asked for a test and the assistant replied.',
    });
    const content = bundle.payload.files[0]?.content ?? '';
    assert.match(content, /How do I test this\?/);
    assert.match(content, /Run the suite\./);
    assert.match(content, /not whole-account history/);
    assert.doesNotMatch(content, /HIDDEN_SYSTEM_RULE/);
    assert.equal(bundle.payload.manifest.files[0]?.coverage, 'partial');
    assert.equal(bundle.preview.upload, false);
  } finally {
    await temp.cleanup();
  }
});

test('bundle hash matches canonical payload and redacts secrets without system prompts', async () => {
  const temp = await makeTemp('assessment-bundle-');
  try {
    const workspace = path.join(temp.dir, 'workspace');
    const root = path.join(temp.dir, 'root');
    await mkdir(workspace, { recursive: true });
    await mkdir(root, { recursive: true });
    await writeCodex(
      path.join(root, 'match.jsonl'),
      workspace,
      'Please help. key sk-abcdefghijklmnopqrstuvwxyz012345 and -----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
    );
    const found = await discover({ roots: [root], workspaceReal: workspace });
    const bundle = await buildBundle({
      candidates: found.catalog,
      workspaceReal: workspace,
      repoSha: 'b'.repeat(40),
      projectSummary: 'Exam workspace summary.',
      collaborationSummary: 'User asked for help. Assistant replied. Tool output was omitted.',
      declaredClients: [{
        name: 'Cursor',
        version: '1.0.0',
        models: [{ name: 'composer', source: 'detected', parameters: { temperature: 0.2 } }],
      }],
    });
    const content = bundle.payload.files[0]?.content ?? '';
    assert.match(content, /Please help/);
    assert.match(content, /Sure, I can help/);
    assert.doesNotMatch(content, /SUPER_SECRET_SYSTEM_PROMPT|DEVELOPER_PROMPT_HIDDEN|HIDDEN_REASONING|SECRET_TOOL_OUTPUT/);
    assert.equal(containsSecretMarker(content), false);
    assert.equal(bundle.payload.files[0]?.name.includes('/'), false);
    assert.equal(bundle.payloadHash, payloadHash(bundle.payload));
    assert.equal(canonicalJson(bundle.payload.manifest), canonicalJson(JSON.parse(canonicalJson(bundle.payload.manifest))));
    const file = bundle.payload.files[0];
    const meta = bundle.payload.manifest.files[0];
    assert.ok(file && meta);
    assert.equal(meta.sha256, sha256Hex(file.content));
    assert.equal(meta.bytes, Buffer.byteLength(file.content, 'utf8'));
    assert.equal(bundle.payload.manifest.clients.some((client) => client.models.some((model) => model.name === 'gpt-5.1' && model.source === 'detected')), true);
    assert.equal(bundle.payload.manifest.clients.some((client) => client.models.some((model) => model.name === 'composer' && model.source === 'reported')), true);
    const reordered = {
      files: bundle.payload.files,
      repoSha: bundle.payload.repoSha,
      schemaVersion: bundle.payload.schemaVersion,
      manifest: {
        collaborationSummary: bundle.payload.manifest.collaborationSummary,
        projectSummary: bundle.payload.manifest.projectSummary,
        clients: bundle.payload.manifest.clients,
        files: bundle.payload.manifest.files,
      },
    };
    assert.equal(payloadHash(reordered), bundle.payloadHash);
  } finally {
    await temp.cleanup();
  }
});


test('explicit generic project exports are accepted without returning file content', async () => {
  const temp = await makeTemp('assessment-generic-');
  try {
    const file = path.join(temp.dir, 'conversation.json');
    await writeFile(file, JSON.stringify({custom_client: 'PRIVATE_TRANSCRIPT_CANARY'}));
    const result = await discover({roots: [temp.dir], workspaceReal: temp.dir, explicitPaths: ['conversation.json']});
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.kind, 'raw-export');
    assert.doesNotMatch(JSON.stringify(result.candidates), /PRIVATE_TRANSCRIPT_CANARY/);
    assert.equal(result.candidates[0]?.clientName, 'unknown');
  } finally { await temp.cleanup(); }
});
