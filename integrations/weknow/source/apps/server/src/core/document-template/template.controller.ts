import { TemplateImagesService } from './template-images.service';
import { Get, Param, Res } from '@nestjs/common';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { Body, Controller, Post, HttpCode, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { User } from '@docmost/db/types/entity.types';
import { DocumentTemplateService } from './template.service';
import {
  TemplateIdDto,
  SaveTemplateDto,
  ApplyTemplateDto,
  DeleteTemplateDto,
} from './template.dto';
@UseGuards(JwtAuthGuard)
@Controller('knowledge-templates')
export class DocumentTemplateController {
  constructor(
    private service: DocumentTemplateService,
    private images: TemplateImagesService,
  ) {}
  @Get('assets/:id')
  @SkipTransform()
  @OAuthScope('read')
  asset(@Param('id') id: string, @Res() res: any) {
    return res
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(this.images.bytes(id));
  }
  @Post('list') @HttpCode(200) @OAuthScope('read') list(
    @AuthUser() user: User,
  ) {
    return this.service.list(user);
  }
  @Post('info') @HttpCode(200) @OAuthScope('read') get(
    @Body() a: TemplateIdDto,
    @AuthUser() user: User,
  ) {
    return this.service.get(a.id, user);
  }
  @Post('save') @HttpCode(200) @OAuthScope('write') save(
    @Body() a: SaveTemplateDto,
    @AuthUser() user: User,
  ) {
    return this.service.save(a, user);
  }
  @Post('apply') @HttpCode(200) @OAuthScope('write') apply(
    @Body() a: ApplyTemplateDto,
    @AuthUser() user: User,
  ) {
    return this.service.apply(a, user);
  }
  @Post('delete') @HttpCode(200) @OAuthScope('write') remove(
    @Body() a: DeleteTemplateDto,
    @AuthUser() user: User,
  ) {
    return this.service.remove(a, user);
  }
}
