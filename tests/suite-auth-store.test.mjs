import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSuiteAuth } from "../apps/platform/server/suite-auth-store.mjs";
import { validateConfig } from "../packages/config/index.mjs";

const config = validateConfig(
  JSON.parse(
    readFileSync(
      new URL("../config/cobuild.local.example.json", import.meta.url),
    ),
  ),
);
async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "cobuild-auth-"));
  let store = openSuiteAuth({ directory, config });
  try {
    await run({
      get store() {
        return store;
      },
      reopen() {
        store.close();
        store = openSuiteAuth({ directory, config });
      },
      directory,
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
const ownerInput = {
  email: "owner@example.test",
  name: "Owner",
  password: "A local test password 123",
};
const bootstrap = async (store) =>
  store.bootstrap(ownerInput, readFileSync(store.bootstrapFile, "utf8").trim());
const cookie = (value) => value.cookie.split(";")[0];
test("first owner requires a private setup credential, is created once and persists across restart", () =>
  fixture(async (f) => {
    await assert.rejects(f.store.bootstrap(ownerInput, "incorrect"), {
      status: 403,
    });
    const result = await bootstrap(f.store);
    assert.equal(f.store.profile(result.session.subject).role, "super_admin");
    assert.equal(existsSync(f.store.bootstrapFile), false);
    const subject = result.session.subject;
    f.reopen();
    assert.equal(f.store.session(cookie(result)).subject, subject);
    assert.equal(f.store.initialized(), true);
    assert.equal(existsSync(f.store.bootstrapFile), false);
    await assert.rejects(bootstrap(f.store));
  }));
test("login uses hashed passwords and logout invalidates the stored session", () =>
  fixture(async ({ store, directory }) => {
    await bootstrap(store);
    await assert.rejects(
      store.login({ ...ownerInput, password: "wrong" }, "test-ip"),
      { status: 401 },
    );
    const result = await store.login(ownerInput, "test-ip");
    assert.match(result.cookie, /HttpOnly; SameSite=Lax/);
    const session = store.session(cookie(result));
    store.csrf(session, session.csrf);
    assert.throws(() => store.csrf(session, "incorrect"), { status: 403 });
    store.logout(session);
    assert.throws(() => store.session(cookie(result)), { status: 401 });
    assert.equal(
      readFileSync(join(directory, "identity.sqlite")).includes(
        Buffer.from(ownerInput.password),
      ),
      false,
    );
  }));
test("invitation is one-use, bound to an email and defaults to a non-administrator", () =>
  fixture(async ({ store }) => {
    const initial = await bootstrap(store),
      owner = store.profile(initial.session.subject),
      invite = store.invite(owner, { email: "member@example.test" });
    const member = await store.accept({
        token: invite.token,
        name: "Member",
        password: "Another test password 123",
      }),
      actor = store.profile(member.session.subject);
    assert.equal(actor.email, "member@example.test");
    assert.equal(actor.role, "member");
    assert.throws(() => store.invite(actor, { email: "other@example.test" }), {
      status: 403,
    });
    await assert.rejects(
      store.accept({
        token: invite.token,
        name: "Again",
        password: "Another test password 123",
      }),
      { status: 410 },
    );
  }));
test("two concurrent accepts cannot create two accounts or consume an invite twice", () =>
  fixture(async ({ store }) => {
    const initial = await bootstrap(store),
      owner = store.profile(initial.session.subject),
      invite = store.invite(owner, { email: "race@example.test" });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        store.accept({
          token: invite.token,
          name: "Race",
          password: "Another test password 123",
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(store.members().length, 2);
  }));
test("member suspension invalidates active sessions immediately and cannot remove the owner", () =>
  fixture(async ({ store }) => {
    const initial = await bootstrap(store),
      owner = store.profile(initial.session.subject),
      invite = store.invite(owner, { email: "member@example.test" });
    const member = await store.accept({
        token: invite.token,
        name: "Member",
        password: "Another test password 123",
      }),
      profile = store.profile(member.session.subject);
    store.updateMember(owner, profile.id, { active: false });
    assert.throws(() => store.session(cookie(member)), { status: 401 });
    assert.throws(
      () => store.updateMember(owner, owner.id, { active: false }),
      { status: 403 },
    );
  }));
test("duplicate cookies fail closed rather than selecting an attacker-controlled session", () =>
  fixture(async ({ store }) => {
    const result = await bootstrap(store);
    assert.throws(() => store.session(cookie(result) + "; " + cookie(result)), {
      status: 401,
    });
  }));
test("personal tokens remain session-bound and evaluate roles live", () =>
  fixture(async ({ store }) => {
    const initial = await bootstrap(store),
      owner = store.profile(initial.session.subject),
      invite = store.invite(owner, { email: "token@example.test" });
    const member = await store.accept({
        token: invite.token,
        name: "Token",
        password: "Token test password 123",
      }),
      actor = store.profile(member.session.subject);
    const issued = store.issueToken(member.session, ["projects:read"]);
    assert.equal(store.inspectToken(issued.token).role, "member");
    store.updateMember(owner, actor.id, { role: "admin" });
    assert.equal(store.inspectToken(issued.token).role, "admin");
    store.logout(member.session);
    assert.throws(() => store.inspectToken(issued.token), { status: 401 });
  }));
test("reactivation preserves role but cannot revive suspended sessions", () =>
  fixture(async ({ store }) => {
    const initial = await bootstrap(store),
      owner = store.profile(initial.session.subject),
      invite = store.invite(owner, {
        email: "reactivate@example.test",
        role: "admin",
      });
    const member = await store.accept({
        token: invite.token,
        name: "Reactivate",
        password: "Reactivate test password 123",
      }),
      id = store.profile(member.session.subject).id;
    store.updateMember(owner, id, { active: false });
    assert.equal(
      store.managedMembers(owner).find((v) => v.id === id).active,
      false,
    );
    store.updateMember(owner, id, { active: true });
    assert.equal(store.profile(id).role, "admin");
    assert.throws(() => store.session(cookie(member)), { status: 401 });
  }));
