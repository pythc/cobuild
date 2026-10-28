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
async function fixture(run, now = Date.now) {
  const directory = mkdtempSync(join(tmpdir(), "cobuild-auth-"));
  let store = openSuiteAuth({ directory, config, now });
  try {
    await run({
      get store() {
        return store;
      },
      reopen() {
        store.close();
        store = openSuiteAuth({ directory, config, now });
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

async function pair(store) {
  const login = await bootstrap(store),
    owner = store.profile(login.session.subject);
  const invite = store.invite(owner, { email: "m@example.test" });
  const member = await store.accept({
    token: invite.token,
    name: "Member",
    password: "Member password 12345",
  });
  return { login, owner, member, p: store.profile(member.session.subject) };
}
test("password changes revoke every session and PAT, require current password", () =>
  fixture(async ({ store }) => {
    const { login } = await pair(store);
    const second = await store.login(ownerInput, "second");
    const pat = store.issueToken(login.session, ["projects:read"]);
    await assert.rejects(
      store.changePassword(login.session, {
        currentPassword: "wrong",
        password: "New password 12345",
      }),
      { status: 403 },
    );
    await store.changePassword(login.session, {
      currentPassword: ownerInput.password,
      password: "New password 12345",
    });
    assert.throws(() => store.session(cookie(second)), { status: 401 });
    assert.throws(() => store.inspectToken(pat.token), { status: 401 });
    await assert.rejects(store.login(ownerInput, "old"), { status: 401 });
    await store.login({ ...ownerInput, password: "New password 12345" }, "new");
  }));
test("recovery is one-use, newest link wins and cannot grant roles", () =>
  fixture(async ({ store }) => {
    const { login, owner, member, p } = await pair(store);
    await assert.rejects(
      store.issueRecovery(member.session, {
        userId: owner.id,
        currentPassword: "Member password 12345",
      }),
      { status: 403 },
    );
    const old = await store.issueRecovery(login.session, {
      userId: p.id,
      currentPassword: ownerInput.password,
    });
    const current = await store.issueRecovery(login.session, {
      userId: p.id,
      currentPassword: ownerInput.password,
    });
    await assert.rejects(
      store.resetPassword(
        { token: old.token, password: "Reset password 12345" },
        "ip",
      ),
      { status: 410 },
    );
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        store.resetPassword(
          { token: current.token, password: "Reset password 12345" },
          "ip",
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.throws(() => store.session(cookie(member)), { status: 401 });
    assert.equal(store.profile(p.id).role, "member");
  }));
test("recovery authorization is rechecked after administrator demotion", () =>
  fixture(async ({ store }) => {
    const { login, owner, p } = await pair(store);
    const inv = store.invite(owner, { email: "a@example.test", role: "admin" });
    const admin = await store.accept({
      token: inv.token,
      name: "Admin",
      password: "Admin password 12345",
    });
    const a = store.profile(admin.session.subject);
    const reset = await store.issueRecovery(admin.session, {
      userId: p.id,
      currentPassword: "Admin password 12345",
    });
    store.updateMember(owner, a.id, { role: "member" });
    await assert.rejects(
      store.resetPassword(
        { token: reset.token, password: "Reset password 12345" },
        "ip",
      ),
      { status: 403 },
    );
  }));
test("owner transfer needs acceptance and revokes former and new owner sessions without copying app roles", () =>
  fixture(async (f) => {
    const { login, owner, member, p } = await pair(f.store);
    await f.store.transferOwner(login.session, {
      action: "request",
      userId: p.id,
      currentPassword: ownerInput.password,
    });
    assert.equal(f.store.profile(p.id).role, "member");
    f.reopen();
    assert.equal(f.store.transferStatus(p).target, p.id);
    await assert.rejects(
      f.store.transferOwner(login.session, {
        action: "accept",
        currentPassword: ownerInput.password,
      }),
      { status: 403 },
    );
    await f.store.transferOwner(member.session, {
      action: "accept",
      currentPassword: "Member password 12345",
    });
    assert.equal(f.store.profile(p.id).role, "super_admin");
    assert.equal(f.store.profile(owner.id).role, "admin");
    assert.throws(() => f.store.session(cookie(login)), { status: 401 });
    assert.throws(() => f.store.session(cookie(member)), { status: 401 });
    assert.equal(
      f.store.members().filter((m) => m.role === "super_admin").length,
      1,
    );
  }));
test("offline recovery targets only the current owner and revokes that owner sessions", () =>
  fixture(async ({ store }) => {
    const { login, owner } = await pair(store);
    const link = store.recoverOwner();
    await store.resetPassword(
      { token: link.token, password: "Owner recovered password 123" },
      "ip",
    );
    assert.throws(() => store.session(cookie(login)), { status: 401 });
    assert.equal(store.profile(owner.id).role, "super_admin");
  }));
test("recovery and ownership invitations expire and a cancelled transfer cannot be accepted", async () => {
  let clock = Date.now();
  await fixture(
    async ({ store }) => {
      const { login, owner, member, p } = await pair(store);
      const reset = await store.issueRecovery(login.session, {
        userId: p.id,
        currentPassword: ownerInput.password,
      });
      clock += 30 * 60000;
      await assert.rejects(
        store.resetPassword(
          { token: reset.token, password: "Expired reset password 123" },
          "ip",
        ),
        { status: 410 },
      );
      const request = () =>
        store.transferOwner(login.session, {
          action: "request",
          userId: p.id,
          currentPassword: ownerInput.password,
        });
      const accept = () =>
        store.transferOwner(member.session, {
          action: "accept",
          currentPassword: "Member password 12345",
        });
      await request();
      await store.transferOwner(member.session, {
        action: "cancel",
        currentPassword: "Member password 12345",
      });
      await assert.rejects(accept(), { status: 410 });
      await request();
      clock += 86400000;
      assert.equal(store.transferStatus(p), null);
      await assert.rejects(accept(), { status: 410 });
      assert.equal(store.profile(owner.id).role, "super_admin");
      assert.equal(store.profile(p.id).role, "member");
      assert.equal(store.session(cookie(member)).subject, p.subject);
    },
    () => clock,
  );
});
test("demoted inviter cannot grant an administrator through an outstanding invitation", () =>
  fixture(async ({ store }) => {
    const { login, owner, member, p } = await pair(store);
    const invite = store.invite(owner, {
      email: "later@example.test",
      role: "admin",
    });
    await store.transferOwner(login.session, {
      action: "request",
      userId: p.id,
      currentPassword: ownerInput.password,
    });
    await store.transferOwner(member.session, {
      action: "accept",
      currentPassword: "Member password 12345",
    });
    await assert.rejects(
      store.accept({
        token: invite.token,
        name: "Late",
        password: "Late password 12345",
      }),
      { status: 410 },
    );
  }));
