import { UnauthorizedException } from "@nestjs/common";
import { sql, Kysely } from "kysely";
import { randomBytes } from "node:crypto";
import { SignupService } from "../services/signup.service";

/** Bootstrap a fresh workspace only. Never infer account ownership from email. */
export async function provisionSuiteAccount(
  db: Kysely<any>,
  signup: SignupService,
  profile: any,
  name: string,
) {
  if (
    profile.provider !== "local" ||
    !profile.name ||
    !profile.email ||
    profile.subject !== profile.tenantKey + ":" + profile.unionId
  )
    throw new UnauthorizedException("Invalid organization identity");
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('cobuild-native-identity',0))`.execute(
      trx,
    );
    let binding = await trx
      .selectFrom("suiteIdentityWorkspaces")
      .selectAll()
      .where("issuer", "=", profile.issuer)
      .where("organizationId", "=", profile.tenantKey)
      .executeTakeFirst();
    if (!binding) {
      const existing = await trx
        .selectFrom("workspaces")
        .select("id")
        .limit(1)
        .executeTakeFirst();
      if (existing || profile.role !== "super_admin")
        throw new UnauthorizedException(
          "Organization owner must initialize a fresh workspace; existing accounts require an explicit migration",
        );
      const result = await signup.initialSetup(
        {
          name: profile.name,
          email: profile.email,
          password: randomBytes(48).toString("base64url"),
          workspaceName: name.slice(0, 50),
        },
        trx as any,
      );
      binding = {
        issuer: profile.issuer,
        organizationId: profile.tenantKey,
        workspaceId: result.workspace.id,
      };
      await trx.insertInto("suiteIdentityWorkspaces").values(binding).execute();
      await trx
        .insertInto("suiteIdentityAccounts")
        .values({
          issuer: profile.issuer,
          subject: profile.subject,
          workspaceId: binding.workspaceId,
          userId: result.user.id,
        })
        .execute();
      return { userId: result.user.id, workspaceId: binding.workspaceId };
    }
    const account = await trx
      .selectFrom("suiteIdentityAccounts")
      .selectAll()
      .where("issuer", "=", profile.issuer)
      .where("subject", "=", profile.subject)
      .executeTakeFirst();
    if (account) {
      if (account.workspaceId !== binding.workspaceId)
        throw new UnauthorizedException("Workspace identity mismatch");
      return account;
    }
    const user = await signup.signup(
      {
        name: profile.name,
        email: profile.email,
        password: randomBytes(48).toString("base64url"),
      },
      binding.workspaceId,
      trx as any,
    );
    await trx
      .insertInto("suiteIdentityAccounts")
      .values({
        issuer: profile.issuer,
        subject: profile.subject,
        workspaceId: binding.workspaceId,
        userId: user.id,
      })
      .execute();
    // Existing workspace and space roles remain owned by WeKnow.
    return { userId: user.id, workspaceId: binding.workspaceId };
  });
}
