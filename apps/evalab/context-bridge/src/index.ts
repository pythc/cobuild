#!/usr/bin/env node
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { diag, safeErrorText } from './diag.js';
import { createBridgeServer } from './server.js';

async function main(): Promise<void> {
  const config = await loadConfig(process.env);
  const server = createBridgeServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  diag('ready');
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // npm exposes bin entries through symlinks; compare their actual file paths.
  try {
    return import.meta.url === pathToFileURL(realpathSync(path.resolve(entry))).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    diag(safeErrorText(error, 'startup failed'));
    process.exitCode = 1;
  });
}
