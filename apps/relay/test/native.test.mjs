import test from "node:test";
import assert from "node:assert/strict";
import { NativeMakit } from "../server/native.mjs";

test("a slow or unavailable Makit cannot block consultation polling and never erases a confirmed ID", async () => {
  let complete,
    calls = 0;
  const gate = new Promise((resolve) => {
    complete = resolve;
  });
  const intent = {
    conversation_id: "c",
    requirement_id: "rec_confirmed",
    payload_json: "{}",
  };
  const service = new NativeMakit({}, { read: async () => intent });
  service.call = async () => {
    calls++;
    await gate;
    return { state: "linked", requirement: { id: "rec_confirmed" } };
  };
  const actor = { employeeId: "staff" };
  await assert.rejects(service.get("c", actor, true), /同步中/);
  await assert.rejects(service.get("c", actor, true), /同步中/);
  assert.equal(calls, 1);
  const direct = service.get("c", actor);
  complete();
  assert.equal((await direct).requirement.id, "rec_confirmed");
  assert.equal(
    (await service.get("c", actor, true)).requirement.id,
    "rec_confirmed",
  );
  assert.equal(intent.requirement_id, "rec_confirmed");
});
