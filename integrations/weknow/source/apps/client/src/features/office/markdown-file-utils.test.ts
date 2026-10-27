import { describe, expect, it } from "vitest";
import { decodeMarkdown, encodeMarkdown, MARKDOWN_LIMIT } from "./markdown-file-utils";
describe("Markdown source fidelity", () => {
  it.each(["# 中文\n\n尾部换行\n", "\ufeff# 中文\r\n\r\n尾部换行\r\n", "# 旧换行\r正文\r", ""])("round-trips UTF-8 bytes %j", text => {
    const bytes = new TextEncoder().encode(text);
    expect(encodeMarkdown(decodeMarkdown(bytes, 7))).toEqual(bytes);
  });
  it("preserves BOM and CRLF after editing", () => {
    const source = decodeMarkdown(new TextEncoder().encode("\ufeff# 标题\r\n"), 2);
    source.text += "新内容\n";
    expect(new TextDecoder("utf-8",{ignoreBOM:true}).decode(encodeMarkdown(source))).toBe("\ufeff# 标题\r\n新内容\r\n");
  });
  it("rejects malformed UTF-8 instead of rewriting damaged text", () => {
    expect(() => decodeMarkdown(new Uint8Array([0xff,0xfe,0x41]),1)).toThrow("UTF-8");
  });
  it("bounds source parsing by bytes", () => {
    expect(() => decodeMarkdown(new Uint8Array(MARKDOWN_LIMIT + 1),1)).toThrow("2 MB");
  });
});
