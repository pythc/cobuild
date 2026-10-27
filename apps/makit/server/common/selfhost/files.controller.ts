import {
  Controller, Get, Post, Param, Req, Res, UseInterceptors,
  UploadedFile, BadRequestException, NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Request, Response } from 'express';
import { NeedLogin } from './platform';
import { DrizzleDatabaseManager } from './database';
import { uploadedFileName } from './file-name';
interface UploadedMakitFile { originalname: string; mimetype: string; buffer: Buffer }
interface StoredFile { original_name: string; mime_type: string; storage_key: string }

@Controller()
@NeedLogin()
export class MakitFilesController {
  constructor(private readonly database: DrizzleDatabaseManager) {}
  @Post('api/selfhost/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 0 } }))
  async upload(@UploadedFile() file: UploadedMakitFile, @Req() req: Request) {
    const name=file?.originalname ? uploadedFileName(file.originalname) : '';
    if (!file?.buffer || !name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) throw new BadRequestException('请选择有效文件');
    const id = randomUUID(), sha = createHash('sha256').update(file.buffer).digest('hex');
    const root = resolve(process.env.MAKIT_FILE_DIRECTORY || '.local/files');
    await mkdir(root, { mode: 0o700, recursive: true });
    // Content-addressed blobs are immutable; a failed metadata write can only
    // leave an unreferenced blob, never destroy another upload.
    await writeFile(resolve(root, sha), file.buffer, { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await this.database.client`INSERT INTO makit_file (id, original_name, mime_type, size_bytes, sha256, storage_key, created_by)
      VALUES (${id}, ${name}, ${file.mimetype || 'application/octet-stream'}, ${file.buffer.length}, ${sha}, ${sha}, ${req.userContext.userId || ''})`;
    return { id, bucketId: 'makit', filePath: id, url: `/api/selfhost/files/${id}` };
  }
  private send(row: StoredFile | undefined, res: Response): void {
    if (!row || !/^[a-f0-9]{64}$/.test(row.storage_key)) throw new NotFoundException('文件不存在');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const disposition = /^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(row.mime_type) ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
    res.sendFile(resolve(process.env.MAKIT_FILE_DIRECTORY || '.local/files', row.storage_key));
  }
  @Get('api/selfhost/files/:id')
  async download(@Param('id') id: string, @Res() res: Response) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new NotFoundException();
    const [row] = await this.database.client<StoredFile[]>`SELECT original_name,mime_type,storage_key FROM makit_file WHERE id=${id}`;
    this.send(row, res);
  }
  @Get('app/app_17b6pxwde0x/runtime/api/v1/storage/object/:bucketId/:filePath')
  async legacy(@Param('bucketId') bucket: string, @Param('filePath') file: string, @Res() res: Response) {
    const [row] = await this.database.client<StoredFile[]>`
      SELECT original_name,mime_type,storage_key FROM makit_file WHERE source_bucket=${bucket} AND source_path=${file}
    `;
    this.send(row, res);
  }
}
