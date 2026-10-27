import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: path.resolve(__dirname, 'client'),
  plugins: [react(), { name: 'selfhost-html', enforce: 'post', generateBundle(_options, bundle) {
    const entry = bundle['selfhost.html'];
    if (entry && entry.type === 'asset') { delete bundle['selfhost.html']; entry.fileName = 'index.html'; bundle['index.html'] = entry; }
  } }],
  resolve: { alias: { '@': path.resolve(__dirname, 'client/src'), '@client': path.resolve(__dirname, 'client'), '@shared': path.resolve(__dirname, 'shared') } },
  define: { 'process.env.CLIENT_BASE_PATH': JSON.stringify('/') },
  build: { outDir: path.resolve(__dirname, 'dist/client'), emptyOutDir: true, rollupOptions: { input: path.resolve(__dirname, 'client/selfhost.html') } },
});
