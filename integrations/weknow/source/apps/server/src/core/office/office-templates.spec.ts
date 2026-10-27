import { execFileSync } from 'node:child_process';
import { blankOffice } from './office-templates';
import * as JSZip from 'jszip';
import { Workbook } from 'exceljs';
describe('New Office files', () => {
  it('creates a Word document with a document part', async () => {
    const zip = await JSZip.loadAsync(await blankOffice('docx'));
    expect(await zip.file('word/document.xml')?.async('string')).toContain(
      'w:document',
    );
  });
  it('creates an Excel workbook that can be reopened with a worksheet', async () => {
    const workbook = new Workbook();
    await workbook.xlsx.load((await blankOffice('xlsx')) as any);
    expect(workbook.worksheets[0].name).toBe('工作表1');
  });
  it('creates a PPTX containing a blank first slide and its layouts', async () => {
    const bytes = execFileSync(
      process.execPath,
      [
        '-r',
        'tsx/cjs',
        '-e',
        "require('./src/core/office/office-templates.ts').blankOffice('pptx').then(b=>process.stdout.write(b))",
      ],
      { cwd: process.cwd() },
    );
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('ppt/slides/slide1.xml')).not.toBeNull();
    expect(zip.file('ppt/slideMasters/slideMaster1.xml')).not.toBeNull();
  });
});
