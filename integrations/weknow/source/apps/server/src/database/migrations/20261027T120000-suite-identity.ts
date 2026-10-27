import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("suiteIdentityWorkspaces")
    .addColumn("issuer", "text", (c) => c.notNull())
    .addColumn("organizationId", "text", (c) => c.notNull())
    .addColumn("workspaceId", "uuid", (c) =>
      c.notNull().unique().references("workspaces.id").onDelete("cascade"),
    )
    .addPrimaryKeyConstraint("suite_identity_workspace_pk", [
      "issuer",
      "organizationId",
    ])
    .execute();
  await db.schema
    .createTable("suiteIdentityAccounts")
    .addColumn("issuer", "text", (c) => c.notNull())
    .addColumn("subject", "text", (c) => c.notNull())
    .addColumn("userId", "uuid", (c) =>
      c.notNull().unique().references("users.id").onDelete("cascade"),
    )
    .addColumn("workspaceId", "uuid", (c) =>
      c.notNull().references("workspaces.id").onDelete("cascade"),
    )
    .addPrimaryKeyConstraint("suite_identity_account_pk", ["issuer", "subject"])
    .execute();
}
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("suiteIdentityAccounts").execute();
  await db.schema.dropTable("suiteIdentityWorkspaces").execute();
}
