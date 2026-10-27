export const MARKDOWN_LIMIT = 2 * 1024 * 1024;
export const isMarkdown = (ext?: string) =>
  ["md", "markdown", "mdown"].includes(ext?.toLowerCase() || "");

export interface MarkdownSource {
  text: string;
  bom: boolean;
  eol: "\n" | "\r\n" | "\r";
  version: number;
}

export function decodeMarkdown(
  bytes: Uint8Array,
  version: number,
): MarkdownSource {
  if (bytes.length > MARKDOWN_LIMIT)
    throw new Error("文件超过 2 MB，请下载后编辑");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("此文件不是 UTF-8 编码，请下载后转为 UTF-8 再上传");
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const breaks = text.match(/\r\n|\r|\n/g) || [];
  const eol =
    breaks.length && breaks.every((x) => x === "\r\n")
      ? "\r\n"
      : breaks.length && breaks.every((x) => x === "\r")
        ? "\r"
        : "\n";
  return { text: text.replace(/\r\n|\r/g, "\n"), bom, eol, version };
}

export function encodeMarkdown(
  source: MarkdownSource,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    (source.bom ? "\ufeff" : "") +
      source.text.replace(/\r\n|\r/g, "\n").replace(/\n/g, source.eol),
  );
}

export async function readMarkdown(
  pageId: string,
  version: number,
  size: number,
  signal?: AbortSignal,
): Promise<MarkdownSource> {
  if (size > MARKDOWN_LIMIT) throw new Error("文件超过 2 MB，请下载后编辑");
  const response = await fetch(
    `/api/office/download/${pageId}?version=${version}`,
    { credentials: "same-origin", signal },
  );
  if (!response.ok) throw new Error("文档读取失败，请刷新后重试");
  return decodeMarkdown(new Uint8Array(await response.arrayBuffer()), version);
}
