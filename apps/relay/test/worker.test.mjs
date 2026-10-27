import test from "node:test";
import assert from "node:assert/strict";
import { NoticeWorker } from "../server/notices.mjs";
test("graceful shutdown waits for an active notification before closing storage", async () => {
  let release,
    stored = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const worker = new NoticeWorker(
    {},
    {
      nextNotice: async () => {
        await gate;
        stored = true;
        return null;
      },
    },
  );
  worker.auth = async () => {};
  worker.start();
  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(stored, true);
  assert.equal(stopped, true);
});
