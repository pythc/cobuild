import test from "node:test";
import assert from "node:assert/strict";
import { canInteract } from "../src/authorization.js";

const config = {
  authorization: {
    ownerOnly: true,
    ownerOpenIds: ["ou_owner"]
  }
};

test("仅管理员可以与机器人交互", () => {
  assert.equal(canInteract(config, "ou_owner"), true);
  assert.equal(canInteract(config, "ou_other"), false);
  assert.equal(canInteract(config, ""), false);
});

test("未启用 ownerOnly 时保持兼容", () => {
  assert.equal(canInteract({ authorization: { ownerOnly: false } }, "ou_other"), true);
});
