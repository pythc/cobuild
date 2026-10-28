// Invoked only with the disposable database created by the local suite harness.
const assert = require("node:assert/strict");
const postgres = require("../apps/makit/node_modules/postgres");
const {
  initializeSuiteCollections,
  configureSuiteCollections,
} = require("../apps/makit/dist/server/common/selfhost/suite-collections");
(async () => {
  const sql = postgres(process.env.MAKIT_DATABASE_URL, {
    max: 1,
    onnotice() {},
  });
  try {
    const count = async () =>
      Number((await sql`SELECT count(*) count FROM makit_record`)[0].count);
    const before = await count();
    assert.ok(before > 0);
    await initializeSuiteCollections(sql);
    await initializeSuiteCollections(sql);
    assert.equal(await count(), before);
    process.env.FEISHU_REQUIREMENTS_TABLE = "external-table";
    assert.throws(configureSuiteCollections);
    delete process.env.FEISHU_REQUIREMENTS_TABLE;
    configureSuiteCollections();
    assert.equal(process.env.FEISHU_REQUIREMENTS_TABLE, "suite-requirements");
    await sql`INSERT INTO makit_collection(id,kind,fields) VALUES('incompatible','incompatible','[]'::jsonb)`;
    try {
      await assert.rejects(
        initializeSuiteCollections(sql),
        /explicit migration/,
      );
    } finally {
      await sql`DELETE FROM makit_collection WHERE id='incompatible'`;
    }
    const [original] =
      await sql`SELECT fields FROM makit_collection WHERE id='suite-comments'`;
    await sql`UPDATE makit_collection SET fields='[]'::jsonb WHERE id='suite-comments'`;
    try {
      await assert.rejects(initializeSuiteCollections(sql), /incompatible/);
    } finally {
      await sql`UPDATE makit_collection SET fields=${sql.json(original.fields)} WHERE id='suite-comments'`;
    }
    assert.equal(await count(), before);
    const [external] = await sql.begin(async tx=>{await tx`SET LOCAL ROLE service_role_public`;return tx`SELECT count(*) count FROM notification_delivery`;});
    assert.equal(Number(external.count), 0);
    console.log(
      JSON.stringify({
        passed: true,
        checks: 7,
        scope:
          "native collection restart preservation and fail-closed initialization",
      }),
    );
  } finally {
    await sql.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
