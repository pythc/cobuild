import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { FileInterceptor } from '../../common/interceptors/file.interceptor';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { OfficeService } from './office.service';
import {
  CreateFileDto,
  DirectoryDto,
  OfficePageDto,
  ConvertFileDto,
  FileTaskDto,
  FileVersionDto,
} from './office.dto';
import { OFFICE_LIMIT } from './office-policy';
function sendFile(res: any, file: any, inline = false) {
  res
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Type', file.mimeType)
    .header(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
  if (inline)
    res
      .header('X-Frame-Options', 'SAMEORIGIN')
      .header('Content-Security-Policy', "frame-ancestors 'self'");
  return res.send(file.stream);
}
@Controller('office')
export class OfficeController {
  constructor(private office: OfficeService) {}
  @UseGuards(JwtAuthGuard)
  @Post('list')
  @HttpCode(200)
  list(@Body() a: DirectoryDto, @AuthUser() user: any, @Req() req: any) {
    return this.office.list({ ...a, cursor: req.body.cursor }, user);
  }
  @UseGuards(JwtAuthGuard)
  @Post('create')
  @HttpCode(200)
  create(@Body() a: CreateFileDto, @AuthUser() user: any) {
    return this.office.create(a, user);
  }
  @UseGuards(JwtAuthGuard)
  @Post('info')
  @HttpCode(200)
  info(@Body() a: OfficePageDto, @AuthUser() user: any) {
    return this.office.info(a.pageId, user);
  }
  @UseGuards(JwtAuthGuard)
  @Post('editor')
  @HttpCode(200)
  editor(@Body() a: OfficePageDto, @AuthUser() user: any) {
    return this.office.editor(a.pageId, user);
  }
  @UseGuards(JwtAuthGuard)
  @Post('convert')
  @HttpCode(200)
  convert(@Body() a: ConvertFileDto, @AuthUser() user: any) {
    return this.office.convert(a.pageId, a.format, a.purpose || 'export', user);
  }
  @UseGuards(JwtAuthGuard)
  @Post('tasks')
  @HttpCode(200)
  tasks(@AuthUser() user: any) {
    return this.office.tasks(user);
  }
  @UseGuards(JwtAuthGuard)
  @Post('task')
  @HttpCode(200)
  task(@Body() a: FileTaskDto, @AuthUser() user: any) {
    return this.office.task(a.taskId, user);
  }
  @UseGuards(JwtAuthGuard)
  @Get('result/:id')
  @SkipTransform()
  async result(
    @Param('id') id: string,
    @AuthUser() user: any,
    @Res() res: any,
  ) {
    return sendFile(res, await this.office.result(id, user));
  }
  @UseGuards(JwtAuthGuard)
  @Get('download/:id')
  @SkipTransform()
  async download(
    @Param('id') id: string,
    @Query('version') version: string,
    @Query('inline') inline: string,
    @AuthUser() user: any,
    @Res() res: any,
  ) {
    if (version && !/^[1-9]\d*$/.test(version))
      throw new BadRequestException('无效的版本');
    const file = await this.office.download(
      id,
      user,
      version ? Number(version) : undefined,
    );
    return sendFile(
      res,
      file,
      inline === '1' &&
        ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(
          file.mimeType,
        ),
    );
  }
  @UseGuards(JwtAuthGuard)
  @Post('restore')
  @HttpCode(200)
  restore(@Body() a: FileVersionDto, @Req() req: any, @AuthUser() user: any) {
    if (!a.version || !Number.isInteger(req.body.expectedVersion))
      throw new BadRequestException('请选择版本');
    return this.office.restore(
      a.pageId,
      a.version,
      req.body.expectedVersion,
      user,
    );
  }
  @UseGuards(JwtAuthGuard)
  @Post('upload')
  @UseInterceptors(FileInterceptor)
  @HttpCode(200)
  async upload(@Req() req: any, @AuthUser() user: any) {
    const file = await req.file({
      limits: { fileSize: OFFICE_LIMIT, files: 1, fields: 5 },
    });
    if (!file) throw new BadRequestException('请选择文件');
    const f = file.fields;
    const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
    const a: any = {
      spaceId: f.spaceId?.value,
      parentPageId: f.parentPageId?.value,
      pageId: f.pageId?.value,
      expectedVersion: Number(f.expectedVersion?.value),
    };
    if (
      (!a.pageId && !uuid.test(a.spaceId || '')) ||
      [a.parentPageId, a.pageId].some((v) => v && !uuid.test(v))
    )
      throw new BadRequestException('无效的上传目录');
    return this.office.upload(a, file, user);
  }
  // These two service endpoints use short-lived signed source tickets / engine JWT,
  // never browser cookies, OAuth bypasses, or anonymous file IDs.
  @Get('source')
  @SkipTransform()
  async source(@Query('token') token: string, @Res() res: any) {
    return sendFile(res, await this.office.source(token));
  }
  @Post('callback/:id')
  @SkipTransform()
  @HttpCode(200)
  callback(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.office.callback(id, body, req.headers.authorization);
  }
}
