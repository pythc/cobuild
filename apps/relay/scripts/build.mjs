import {build} from 'esbuild';
import {build as viteBuild} from 'vite';
await viteBuild({configFile:false,base:'/relay/',build:{outDir:'dist/client',rollupOptions:{input:{main:'index.html',unread:'unread.html'}}},plugins:[(await import('@vitejs/plugin-react')).default()]});
await build({entryPoints:['server/main.mjs'],platform:'node',target:'node24',bundle:true,format:'esm',outfile:'dist/server.mjs',minify:false,banner:{js:'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);'},external:['node:*']});
