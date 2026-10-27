import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Build existing applications without packaging the excluded desktop plugin or public website.
const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
  env: { ...process.env, COBUILD_SUITE_BUILD: '1' }
});
if (result.error) {
  console.error('Suite build could not start');
  process.exitCode = 1;
} else process.exitCode = result.status ?? 1;
