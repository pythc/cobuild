import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

export async function makeTemp(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export function codexSession(options: {
  cwd: string;
  userText: string;
  assistantText?: string;
  model?: string;
  extra?: unknown[];
}): string {
  const lines = [
    {
      timestamp: '2026-09-28T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: '11111111-1111-4111-8111-111111111111',
        cwd: options.cwd,
        originator: 'codex-tui',
        cli_version: '0.99.0',
        source: 'cli',
        model_provider: 'openai',
        base_instructions: { text: 'SUPER_SECRET_SYSTEM_PROMPT do not reveal' },
      },
    },
    {
      timestamp: '2026-09-28T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'DEVELOPER_PROMPT_HIDDEN' }],
      },
    },
    {
      timestamp: '2026-09-28T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: options.userText }],
      },
    },
    {
      timestamp: '2026-09-28T00:00:03.000Z',
      type: 'turn_context',
      payload: { cwd: options.cwd, model: options.model ?? 'gpt-5.1' },
    },
    {
      timestamp: '2026-09-28T00:00:04.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: ['HIDDEN_REASONING'] },
    },
    {
      timestamp: '2026-09-28T00:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_test',
        output: 'SECRET_TOOL_OUTPUT ghp_abcdefghijklmnopqrstuvwxyz012345',
      },
    },
    {
      timestamp: '2026-09-28T00:00:06.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: options.assistantText ?? 'Sure, I can help.' }],
      },
    },
    ...(options.extra ?? []),
  ];
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

export async function writeCodex(file: string, cwd: string, userText: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, codexSession({ cwd, userText }), 'utf8');
}
