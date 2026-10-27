import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readCodexTranscript } from '../src/codex.ts';
import { readCursorExport } from '../src/cursorExport.ts';
import { MAX_CURSOR_RAW_BYTES } from '../src/limits.ts';
import { makeTemp } from './helpers.ts';

test('Codex projection keeps visible user and assistant text only', async () => {
  const temp = await makeTemp('assessment-codex-channel-');
  try {
    const file = path.join(temp.dir, 'session.jsonl');
    const row = (role: string, channel: string, text: string) => ({
      type: 'response_item',
      payload: { type: 'message', role, channel, content: [{ type: 'output_text', text }] },
    });
    await writeFile(file, [
      { type: 'session_meta', payload: { cwd: temp.dir } },
      row('system', 'final', 'hidden system'),
      row('developer', 'final', 'hidden developer'),
      row('assistant', 'analysis', 'private internal reasoning'),
      row('user', 'final', '帮我运行测试'),
      row('assistant', 'commentary', '正在检查测试'),
      row('assistant', 'final', '测试通过'),
    ].map((item) => JSON.stringify(item)).join('\n'));
    const result = await readCodexTranscript(file, temp.dir);
    assert.deepEqual(result.turns.map((turn) => turn.text), ['帮我运行测试', '正在检查测试', '测试通过']);
  } finally {
    await temp.cleanup();
  }
});

test('Cursor raw files over 8MB are marked truncated without reading the tail', async () => {
  const temp = await makeTemp('assessment-cursor-raw-');
  try {
    const file = path.join(temp.dir, 'chat.jsonl');
    const header = [
      JSON.stringify({ role: 'user', content: 'VISIBLE_USER' }),
      JSON.stringify({ role: 'assistant', content: 'VISIBLE_ASSISTANT' }),
    ].join('\n') + '\n';
    const tail = Buffer.concat([
      Buffer.from('TAIL_NOT_INCLUDED'),
      Buffer.alloc(MAX_CURSOR_RAW_BYTES, 0x78),
    ]);
    await writeFile(file, Buffer.concat([Buffer.from(header), tail]));
    const result = await readCursorExport(file);
    assert.equal(result.rawTruncated, true);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.turns.map((turn) => turn.text), ['VISIBLE_USER', 'VISIBLE_ASSISTANT']);
    assert.equal(result.turns.some((turn) => turn.text.includes('TAIL_NOT_INCLUDED')), false);
  } finally {
    await temp.cleanup();
  }
});
