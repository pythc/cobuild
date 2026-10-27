import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelayStore } from "../server/store.mjs";
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-standalone-")),
    s = new RelayStore(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
test("mixed imported timestamps sort by the actual instant, not text offsets", async (t) => {
  const s = setup(t);
  for (const [id, created_at] of [
    ["old", "2026-10-15T15:10:06+08:00"],
    ["new", "2026-10-15T09:44:05.000Z"],
  ])
    await s.register(
      {
        id,
        principal: "p",
        app: "makit",
        remote_id: id === "old" ? 1 : 2,
        source_id: "s",
        created_at,
      },
      "User",
    );
  assert.deepEqual(
    (await s.conversations("p")).map((r) => r.id),
    ["new", "old"],
  );
});
test("concurrent reception, handover and reopening preserve one winner", async (t) => {
  const s = setup(t);
  await s.register(
    {
      id: "x",
      principal: "p",
      app: "makit",
      remote_id: 1,
      source_id: "s",
      created_at: new Date().toISOString(),
    },
    "User",
  );
  const p = { id: "a", name: "A", claimedAt: new Date().toISOString() };
  const winners = await Promise.all([
    s.claim("x", p),
    s.claim("x", { ...p, id: "b" }),
  ]);
  assert.equal(winners[0].id, winners[1].id);
  const next = await Promise.all([
    s.claim("x", { ...p, id: "c" }, "a"),
    s.claim("x", { ...p, id: "d" }, "a"),
  ]);
  assert.equal(next[0].id, next[1].id);
  assert.equal(next[0].id, "c");
  assert.equal((await s.get("x")).id, "c");
});
test("opening stays provisional; first delivery and group notification are durable and idempotent", async (t) => {
  const s = setup(t);
  const row = {
    id: "c",
    principal: "p",
    app: "makit",
    remote_id: 1,
    source_id: "s",
    created_at: new Date().toISOString(),
  };
  await s.register(row, "User");
  await s.register(row, "User");
  assert.equal(await s.nextNotice(), null);
  assert.equal(
    (await s.conversations()).length,
    0,
    "empty windows stay out of the operator queue",
  );
  assert.equal(
    (await s.conversations("p")).length,
    1,
    "customer can keep their provisional session",
  );
  await Promise.all([
    s.activate(row.id, "12", row.created_at),
    s.activate(row.id, "13", row.created_at),
  ]);
  assert.equal((await s.conversations()).length, 1);
  const jobs = await Promise.all([s.nextNotice(), s.nextNotice()]);
  assert.equal(jobs.filter(Boolean).length, 1);
  const job = jobs.find(Boolean);
  assert.equal(
    (await s.noticeResult(job.id, "bad", "sent", "om_bad")).accepted,
    false,
  );
  assert.equal(
    (await s.noticeResult(job.id, job.lease, "unknown")).accepted,
    true,
  );
  assert.equal(await s.nextNotice(), null);
  assert.equal((await s.conversations("p")).length, 1);
});
test("uncertain message operations cannot be claimed again on restart or changed under the same key", async (t) => {
  const s = setup(t),
    v = await s.reserve("marker", "hash");
  await s.writing(v.row);
  await s.fail(v.row, false);
  assert.equal((await s.reserve("marker", "hash")).claimed, false);
  await assert.rejects(s.reserve("marker", "different"));
  await s.done(v.row, { id: "confirmed" });
  assert.equal(
    JSON.parse((await s.reserve("marker", "hash")).row.response_json).id,
    "confirmed",
  );
});
test("expired notice lease retries with the same frozen payload; late receipts are fenced", async (t) => {
  const s = setup(t);
  await s.register(
    {
      id: "late",
      principal: "p",
      app: "makit",
      remote_id: 2,
      source_id: "s",
      created_at: new Date().toISOString(),
    },
    "User",
  );
  await s.activate("late", "20", new Date().toISOString());
  const job = await s.nextNotice();
  const payload={uuid:job.id.slice(0,32),content:"fixed"};
  s.freezeNotice(job,payload);
  s.db
    .prepare("UPDATE notices SET lease_expires_at=? WHERE id=?")
    .run(Date.now() - 1, job.id);
  const retry=await s.nextNotice();
  assert.equal(retry.id,job.id);assert.notEqual(retry.lease,job.lease);assert.deepEqual(retry.payload,payload);
  assert.equal(
    (await s.noticeResult(job.id, job.lease, "sent", "om_late")).accepted,
    false,
  );
  s.db.prepare("UPDATE notices SET lease_expires_at=?,first_attempt=? WHERE id=?").run(Date.now()-1,Date.now()-3100000,job.id);
  assert.equal(await s.nextNotice(),null);
  assert.equal(s.db.prepare("SELECT state FROM notices WHERE id=?").get(job.id).state,"unknown");
});
