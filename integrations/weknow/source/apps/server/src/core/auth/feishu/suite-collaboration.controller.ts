import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { verifyService } from "./suite-channel";
import { SuiteCollaborationService } from "./suite-collaboration.service";
@Controller("suite/projects")
export class SuiteCollaborationController {
  constructor(private service: SuiteCollaborationService) {}
  @Post("ensure")
  @HttpCode(200)
  async ensure(@Req() req: any, @Body() body: unknown) {
    let payload;
    try {
      if (
        process.env.COBUILD_IDENTITY_MODE !== "local" ||
        process.env.COBUILD_MODULE_ENABLED !== "true"
      )
        throw Error();
      payload = verifyService(
        req.headers,
        body,
        "/api/suite/projects/ensure",
        process.env.COBUILD_SERVICE_KEY_FILE!,
      );
      if (
        payload.organizationId !== process.env.LAB_IDENTITY_TENANT_KEY ||
        Object.keys(payload).some(
          (k) => !["organizationId", "projectId", "revision", "name", "expectedName", "archived"].includes(k),
        ) || !Number.isSafeInteger(payload.revision) || payload.revision<1 ||
        typeof payload.archived!=='boolean' ||
        [payload.name,payload.expectedName].some(v=>typeof v!=='string'||!v.trim()||v.length>80)
      )
        throw Error();
    } catch {
      throw new UnauthorizedException("Invalid suite service request");
    }
    return this.service.ensure(payload.projectId,payload);
  }
}
