import { Document, Packer, Paragraph } from 'docx';
import { Workbook } from 'exceljs';
const PptxGenJS = require('pptxgenjs') as typeof import('pptxgenjs').default;
import { BadRequestException } from '@nestjs/common';
/** Generate real OOXML packages using maintained format libraries. */
export async function blankOffice(ext: string): Promise<Buffer> {
  if (ext === 'docx')
    return Packer.toBuffer(
      new Document({
        styles: {
          default: {
            document: {
              run: {
                font: 'Noto Serif CJK SC',
                language: { value: 'zh-CN', eastAsia: 'zh-CN' },
              },
            },
          },
        },
        sections: [{ children: [new Paragraph('')] }],
      }),
    );
  if (ext === 'xlsx') {
    const workbook = new Workbook();
    workbook.addWorksheet('工作表1');
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
  if (ext === 'pptx') {
    const presentation = new PptxGenJS();
    presentation.layout = 'LAYOUT_WIDE';
    presentation.theme = {
      headFontFace: 'Noto Sans CJK SC',
      bodyFontFace: 'Noto Sans CJK SC',
    };
    presentation.addSlide();
    return Buffer.from(
      (await presentation.write({ outputType: 'nodebuffer' })) as Buffer,
    );
  }
  throw new BadRequestException('不支持此文件类型');
}
