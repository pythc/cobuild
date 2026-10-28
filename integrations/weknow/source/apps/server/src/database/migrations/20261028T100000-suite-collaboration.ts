import { Kysely } from "kysely";
export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable("suiteIdentityAccounts")
    .addColumn("active", "boolean", (c) => c.notNull().defaultTo(true))
    .execute();
  await db.schema
    .createTable("suiteProjectSpaces")
    .addColumn("organizationId", "text", (c) => c.notNull())
    .addColumn("projectId", "uuid", (c) => c.notNull())
    .addColumn("spaceId", "uuid", (c) =>
      c.notNull().unique().references("spaces.id").onDelete("restrict"),
    )
    .addColumn("workspaceId", "uuid", (c) =>
      c.notNull().references("workspaces.id").onDelete("cascade"),
    )
    .addPrimaryKeyConstraint("suite_project_spaces_pk", [
      "organizationId",
      "projectId",
    ])
    .execute();
}
export async function down(db: Kysely<any>) {
  // This mapping is required for idempotency. Downgrade applications without deleting it.
  throw new Error(
    "Keep suite project receipts when rolling back; restore a verified backup for schema rollback",
  );
}
