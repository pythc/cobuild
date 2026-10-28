import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  ServiceUnavailableException,
  ForbiddenException,
  ConflictException,
} from "@nestjs/common";
import { InjectKysely } from "nestjs-kysely";
import { Kysely, sql } from "kysely";
import { SignupService } from "../services/signup.service";
import { SpaceService } from "../../space/services/space.service";
import { provisionSuiteAccount } from "./suite-identity";
import { serviceRequest } from "./suite-channel";
import { isUserDisabled } from "../../../common/helpers";
@Injectable()
export class SuiteCollaborationService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closed = false;
  private directoryFailed = false;
  private logger = new Logger(SuiteCollaborationService.name);
  constructor(
    @InjectKysely() private db: Kysely<any>,
    private signup: SignupService,
    private spaces: SpaceService,
  ) {}
  private get native() {
    return process.env.COBUILD_IDENTITY_MODE === "local";
  }
  private get organizationId() {
    return process.env.LAB_IDENTITY_TENANT_KEY!;
  }
  private get issuer() {
    return process.env.LAB_IDENTITY_ORIGIN!;
  }
  private call(action: string, input: Record<string, unknown> = {}) {
    return serviceRequest(
      this.issuer,
      "/api/suite/services/weknow/" + action,
      { ...input, organizationId: this.organizationId },
      process.env.COBUILD_SERVICE_KEY_FILE!,
    );
  }
  onModuleInit() {
    if (this.native && process.env.COBUILD_SERVICE_KEY_FILE) {
      this.timer = setInterval(() => {
        this.syncDirectory()
          .then(() => {
            if (this.directoryFailed)
              this.logger.log("Suite directory synchronization recovered");
            this.directoryFailed = false;
          })
          .catch(() => {
            if (!this.directoryFailed)
              this.logger.warn(
                "Suite directory unavailable; existing app roles retained, authorization remains live",
              );
            this.directoryFailed = true;
          });
      }, 15000);
      this.timer.unref();
    }
  }
  async onModuleDestroy() {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending?.catch(() => {});
  }
  syncDirectory() {
    if (!this.native || this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.sync().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async sync() {
    // Initialization is explicit: the organization owner must connect WeKnow once.
    const binding = await this.db
      .selectFrom("suiteIdentityWorkspaces")
      .selectAll()
      .where("issuer", "=", this.issuer)
      .where("organizationId", "=", this.organizationId)
      .executeTakeFirst();
    if (!binding) return;
    const snapshot = await this.call("directory");
    if (
      snapshot.organizationId !== this.organizationId ||
      !Array.isArray(snapshot.members) ||
      !snapshot.members.length ||
      snapshot.members.length > 10000 ||
      new Set(snapshot.members.map((m: any) => m.id)).size !==
        snapshot.members.length ||
      snapshot.members.some(
        (m: any) =>
          !/^[-a-f0-9]{36}$/.test(m.id) ||
          m.subject !== this.organizationId + ":" + m.id ||
          typeof m.active !== "boolean" ||
          !m.name ||
          !m.email,
      )
    )
      throw new ServiceUnavailableException(
        "Invalid complete organization directory",
      );
    for (const member of snapshot.members.filter((m: any) => m.active))
      await provisionSuiteAccount(
        this.db,
        this.signup,
        {
          ...member,
          issuer: this.issuer,
          tenantKey: this.organizationId,
          unionId: member.id,
          provider: "local",
        },
        process.env.COBUILD_ORGANIZATION_NAME || "CoBuild",
      );
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("suiteIdentityAccounts")
        .set({ active: false })
        .where("issuer", "=", this.issuer)
        .where("workspaceId", "=", binding.workspaceId)
        .execute();
      const active = snapshot.members
        .filter((m: any) => m.active)
        .map((m: any) => m.subject);
      if (active.length)
        await trx
          .updateTable("suiteIdentityAccounts")
          .set({ active: true })
          .where("issuer", "=", this.issuer)
          .where("workspaceId", "=", binding.workspaceId)
          .where("subject", "in", active)
          .execute();
    });
  }
  async ensure(projectId: string) {
    if (!this.native || !/^[-a-f0-9]{36}$/.test(projectId || ""))
      throw new ForbiddenException("Invalid suite project");
    const { project, owner } = await this.call("project", { projectId });
    if (
      project.id !== projectId ||
      project.phase !== "active" ||
      project.archived ||
      !project.knowledgeSpace?.requested ||
      owner.subject !== project.ownerSubject
    )
      throw new ForbiddenException("Project is not approved");
    await this.syncDirectory();
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":project:" + projectId},0))`.execute(
        trx,
      );
      const binding = await trx
        .selectFrom("suiteIdentityWorkspaces")
        .selectAll()
        .where("issuer", "=", this.issuer)
        .where("organizationId", "=", this.organizationId)
        .executeTakeFirst();
      if (!binding)
        throw new ServiceUnavailableException(
          "Organization owner must initialize WeKnow first",
        );
      const receipt = await trx
        .selectFrom("suiteProjectSpaces")
        .selectAll()
        .where("organizationId", "=", this.organizationId)
        .where("projectId", "=", projectId)
        .executeTakeFirst();
      let space;
      if (receipt) {
        if (receipt.workspaceId !== binding.workspaceId)
          throw new ConflictException("Workspace mapping mismatch");
        space = await trx
          .selectFrom("spaces")
          .selectAll()
          .where("id", "=", receipt.spaceId)
          .where("workspaceId", "=", binding.workspaceId)
          .where("deletedAt", "is", null)
          .executeTakeFirst();
        if (!space)
          throw new ConflictException(
            "Linked space unavailable; restore it rather than create a duplicate",
          );
      } else {
        const account = await trx
          .selectFrom("suiteIdentityAccounts")
          .selectAll()
          .where("issuer", "=", this.issuer)
          .where("subject", "=", owner.subject)
          .where("active", "=", true)
          .executeTakeFirst();
        if (!account || account.workspaceId !== binding.workspaceId)
          throw new ForbiddenException("Project owner unavailable");
        const user = await trx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", account.userId)
          .executeTakeFirst();
        if (!user || isUserDisabled(user))
          throw new ForbiddenException("Project owner unavailable");
        space = await this.spaces.createSpace(
          user as any,
          binding.workspaceId,
          {
            name: project.name,
            slug: "project-" + projectId,
            description: project.summary,
          },
          trx as any,
        );
        await trx
          .insertInto("suiteProjectSpaces")
          .values({
            organizationId: this.organizationId,
            projectId,
            spaceId: space.id,
            workspaceId: binding.workspaceId,
          })
          .execute();
      }
      return {
        projectId,
        spaceId: space.id,
        name: space.name,
        slug: space.slug,
        url: process.env.APP_URL + "/s/" + space.slug,
      };
    });
  }
}
