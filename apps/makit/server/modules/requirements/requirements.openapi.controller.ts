import {LabIdentityService} from './lab-identity.service';
import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { Request, Response } from 'express';
import { McpPersonalTokenService } from './mcp-personal-token.service';
import { RequirementsMcpService } from './requirements-mcp.service';
import { withSelfhostActor } from '../../common/selfhost/context';

@Controller('openapi/mcp')
export class RequirementsOpenApiController {
  constructor(
    private readonly identity:LabIdentityService,
    private readonly mcpService: RequirementsMcpService,
    private readonly personalTokenService: McpPersonalTokenService,
  ) {}

  @Post()
  async post(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    await this.handle(req, res, body);
  }

  @Get()
  async get(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handle(req, res);
  }

  private async handle(
    req: Request,
    res: Response,
    body?: unknown,
  ): Promise<void> {
    const personalTokenHeader: string | string[] | undefined =
      req.headers['x-requirement-mcp-token'];
    const personalToken: string = Array.isArray(personalTokenHeader)
      ? personalTokenHeader[0] || ''
      : personalTokenHeader || '';
    if (!personalToken) {
      throw new UnauthorizedException('缺少个人 MCP Key');
    }
    const grant=req.headers['x-lab-identity-token'];
    if(Array.isArray(grant))throw new UnauthorizedException();
    const actor=grant?await this.identity.verify(grant,personalToken):await this.personalTokenService.verify(personalToken);
    return withSelfhostActor(actor, async () => {
    const server: McpServer = this.mcpService.createServer(actor);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, body);
    } finally {
      await server.close();
    }
    });
  }
}
