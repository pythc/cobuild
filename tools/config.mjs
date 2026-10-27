import { readFile } from 'node:fs/promises';
import { validateConfig, planConfig } from '../packages/config/index.mjs';

const [command, path] = process.argv.slice(2);
if (!['check', 'plan'].includes(command) || !path) {
  console.error('Usage: node tools/config.mjs check|plan <configuration.json>');
  process.exitCode = 2;
} else {
  try {
    const config = JSON.parse(await readFile(path, 'utf8'));
    console.log(JSON.stringify(command === 'plan' ? planConfig(config) : { valid: Boolean(validateConfig(config)), runtimeConfigured: false }, null, 2));
  } catch (error) {
    console.error(error instanceof TypeError ? error.message : 'Configuration could not be read or parsed');
    process.exitCode = 1;
  }
}
