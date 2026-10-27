// File parsing runs outside the HTTP process and is killed on timeout.
import * as mammoth from 'mammoth';
import JSZip = require('jszip');
import { extractText } from '@docmost/pdf-inspector';
import { load } from 'cheerio';

export async function extractFileText(
  bytes: Buffer,
  ext: string,
): Promise<string> {
  if (bytes.length > 20 * 1024 * 1024)
    throw new Error('文件超过全文索引的 20 MB 限制');
  let text = '';
  if (['txt', 'md', 'csv', 'json', 'log'].includes(ext)) {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else if (ext === 'pdf') text = extractText(bytes);
  else if (['docx', 'xlsx', 'pptx'].includes(ext)) {
    const zip = await JSZip.loadAsync(bytes);
    const files = Object.values(zip.files).filter((f) => !f.dir);
    if (
      files.length > 5000 ||
      files.reduce(
        (n, f) => n + Number((f as any)._data?.uncompressedSize || 0),
        0,
      ) >
        32 * 1024 * 1024
    )
      throw new Error('解压内容超过索引限制');
    if (ext === 'docx')
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    else if (ext === 'pptx') {
      const parts = files
        .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name))
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        );
      for (const f of parts) {
        const $ = load(await f.async('string'), { xmlMode: true });
        text +=
          $('a\\:t')
            .map((_, e) => $(e).text())
            .get()
            .join(' ') + '\n';
      }
    } else {
      const shared = zip.file('xl/sharedStrings.xml');
      let strings: string[] = [];
      if (shared) {
        const $ = load(await shared.async('string'), { xmlMode: true });
        strings = $('si')
          .map((_, e) =>
            $(e)
              .find('t')
              .map((_, t) => $(t).text())
              .get()
              .join(''),
          )
          .get();
      }
      for (const f of files.filter((f) =>
        /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name),
      )) {
        const $ = load(await f.async('string'), { xmlMode: true });
        text +=
          $('c')
            .map((_, e) =>
              $(e).attr('t') === 's'
                ? strings[Number($(e).find('v').text())] || ''
                : $(e)
                    .find('v,t')
                    .map((_, t) => $(t).text())
                    .get()
                    .join(' '),
            )
            .get()
            .join(' ') + '\n';
      }
    }
  } else throw new Error('此格式暂不支持全文索引');
  if (text.length > 1_000_000) throw new Error('提取文本超过 100 万字符限制');
  return text.replace(/\u0000/g, '').trim();
}

if (require.main === module) {
  const chunks: Buffer[] = [];
  let length = 0;
  process.stdin.on('data', (b) => {
    length += b.length;
    if (length > 20 * 1024 * 1024) process.exit(2);
    chunks.push(Buffer.from(b));
  });
  process.stdin.on('end', () =>
    extractFileText(Buffer.concat(chunks), process.argv[2])
      .then((text) => process.stdout.write(JSON.stringify({ text })))
      .catch(() => {
        process.stdout.write(
          JSON.stringify({
            error: '无法提取文本：格式不支持、文件损坏、编码或大小超限',
          }),
        );
      }),
  );
}
