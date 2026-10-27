import { extractFileText } from './file-text.worker';
import JSZip = require('jszip');
async function office(path: string, xml: string) {
  const zip = new JSZip();
  zip.file(path, xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}
describe('bounded file indexing', () => {
  it('extracts UTF-8 Chinese text', async () =>
    expect(await extractFileText(Buffer.from('容灾演练\0记录'), 'txt')).toBe(
      '容灾演练记录',
    ));
  it('refuses undecodable text instead of indexing replacement characters', async () =>
    expect(extractFileText(Buffer.from([0xff]), 'txt')).rejects.toThrow());
  it('extracts worksheet inline text', async () =>
    expect(
      await extractFileText(
        await office(
          'xl/worksheets/sheet1.xml',
          '<worksheet><c t="inlineStr"><is><t>发布验收</t></is></c></worksheet>',
        ),
        'xlsx',
      ),
    ).toBe('发布验收'));
  it('extracts presentation text', async () =>
    expect(
      await extractFileText(
        await office(
          'ppt/slides/slide1.xml',
          '<p:sld xmlns:p="p" xmlns:a="a"><a:t>容灾目标</a:t></p:sld>',
        ),
        'pptx',
      ),
    ).toBe('容灾目标'));
  it('extracts a Word document body', async () => {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>蓝绿发布验收</w:t></w:r></w:p></w:body></w:document>',
    );
    expect(
      await extractFileText(
        await zip.generateAsync({ type: 'nodebuffer' }),
        'docx',
      ),
    ).toBe('蓝绿发布验收');
  });
  it('extracts actual PDF text streams', async () => {
    const stream = 'BT /F1 12 Tf 20 30 Td (Rollback verification) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((obj, i) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf +=
      `xref\n0 6\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
        .join('') +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    expect(await extractFileText(Buffer.from(pdf), 'pdf')).toContain(
      'Rollback verification',
    );
  });
  it('rejects oversized and corrupt files', async () => {
    await expect(
      extractFileText(Buffer.alloc(20 * 1024 * 1024 + 1), 'txt'),
    ).rejects.toThrow('20 MB');
    await expect(
      extractFileText(Buffer.from('broken'), 'docx'),
    ).rejects.toThrow();
  });
  it('rejects unsupported formats explicitly', async () =>
    expect(extractFileText(Buffer.from('x'), 'exe')).rejects.toThrow(
      '暂不支持',
    ));
});
