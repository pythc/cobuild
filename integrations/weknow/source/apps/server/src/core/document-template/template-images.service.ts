import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { TEMPLATE_ASSETS } from './template-assets';
import { StorageService } from '../../integrations/storage/storage.service';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
@Injectable()
export class TemplateImagesService {
  constructor(
    private storage: StorageService,
    private attachments: AttachmentRepo,
  ) {}
  bytes(id: string) {
    if (!/^[a-f0-9]{24}$/.test(id) || !TEMPLATE_ASSETS[id])
      throw new NotFoundException('图片不存在');
    return Buffer.from(TEMPLATE_ASSETS[id], 'base64');
  }
  async prepare(html: string, user: any, spaceId: string, staged: string[]) {
    const dom = load(html, null, false),
      files: any[] = [];
    for (const image of dom('img').toArray()) {
      const src = dom(image).attr('src') || '';
      const match = src.match(
        /^\/api\/knowledge-templates\/assets\/([a-f0-9]{24})$/,
      );
      if (!match) continue;
      const bytes = this.bytes(match[1]),
        id = randomUUID(),
        fileName = 'template-' + match[1] + '.png',
        filePath = `${user.workspaceId}/files/${id}/${fileName}`;
      staged.push(filePath);
      await this.storage.upload(filePath, bytes);
      files.push({
        id,
        fileName,
        filePath,
        fileSize: bytes.length,
        fileExt: 'png',
        mimeType: 'image/png',
        type: 'file',
        creatorId: user.id,
        workspaceId: user.workspaceId,
        spaceId,
      });
      dom(image)
        .attr('src', `/api/files/${id}/${fileName}`)
        .attr('data-attachment-id', id);
    }
    return { html: dom.html(), files };
  }
  async attach(files: any[], pageId: string, trx: any) {
    for (const file of files)
      await this.attachments.insertAttachment({ ...file, pageId }, trx);
  }
  async clean(paths: string[]) {
    await Promise.all(
      paths.map((x) => this.storage.delete(x).catch(() => undefined)),
    );
  }
}
