const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
async function build() {
  // tsc preserves Nest constructor metadata; esbuild alone would not.
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.node.json'], { stdio: 'inherit' });
  const platform = path.resolve('dist/server/common/selfhost/platform.js');
  const result = await esbuild.build({
    entryPoints: ['dist/server/selfhost-main.js'], bundle: true, platform: 'node', target: 'node22',
    format: 'cjs', outfile: 'dist/selfhost/server.cjs', packages: 'external', metafile: true,
    alias: { '@lark-apaas/fullstack-nestjs-core': platform, '@lark-apaas/nestjs-common': platform,
      '@shared': path.resolve('dist/shared') },
    logLevel: 'warning',
  });
  if (Object.values(result.metafile.outputs).some((output) => output.imports.some((entry) => entry.path.startsWith('@lark-apaas/')))) {
    throw new Error('Selfhost runtime still imports the managed SDK');
  }
  await fs.writeFile('dist/selfhost/build-manifest.json', JSON.stringify({
    runtime: 'selfhost', managedSdkImports: 0, builtAt: new Date().toISOString(),
  }, null, 2));
}
build().catch(() => { console.error('Selfhost server build failed.'); process.exitCode = 1; });
