const { createHttpServer } = await import('../../apps/platform/server/http.mjs');
const server = await createHttpServer();
server.listen(4100, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(async () => { await server.workflowClosed; process.exit(0); });
  setTimeout(() => process.exit(1), 25000).unref();
});
