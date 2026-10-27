import { createServer } from 'node:http';
import { createApp } from './app.js';
import { closeContext, createContext } from './context.js';
import { startWorkers } from './workers.js';

const ctx = await createContext();
const app = createApp(ctx);
const stopWorkers = startWorkers(ctx);
const server = createServer(app);
server.listen(ctx.config.port, () => {
  console.log(JSON.stringify({ component: 'server', event: 'listening', port: ctx.config.port }));
});

async function shutdown(): Promise<void> {
  stopWorkers();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeContext(ctx);
}

process.on('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});
