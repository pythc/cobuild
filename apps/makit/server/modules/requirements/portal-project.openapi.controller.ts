import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import type {
  PortalProjectLookupResponse,
  PortalProjectSummary,
  ProjectCatalogResponse,
} from '@shared/api.interface';
import { PortalProjectService } from './portal-project.service';

// Authentication is enforced by Miaoda's OpenAPI gateway. The dedicated
// first-party key grants only the three project-sync routes; no user roles are elevated.
@Controller('openapi/workspace/projects')
export class PortalProjectOpenApiController {
  constructor(private readonly projects: PortalProjectService) {}
  @Post('catalog')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  catalog(): Promise<ProjectCatalogResponse> {
    return this.projects.catalog();
  }
  @Post('sync')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  sync(@Body() body: unknown): Promise<PortalProjectSummary> {
    return this.projects.register(body);
  }
  @Post('lookup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  lookup(@Body() body: unknown): Promise<PortalProjectLookupResponse> {
    return this.projects.lookup(body);
  }
}
