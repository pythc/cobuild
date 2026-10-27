import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import {
  KnowledgeLinks,
  insertKnowledgeLink,
  knowledgeLinkKey,
} from "./knowledge-link";
import { parseKnowledgeLink } from "../components/link/knowledge-link-target";
import {
  getPageById,
  getAttachmentInfo,
} from "@/features/page/services/page-service";
vi.mock("@/features/page/services/page-service", () => ({
  getPageById: vi.fn(),
  getAttachmentInfo: vi.fn(),
}));
const editors: Editor[] = [];
const url = window.location.origin + "/s/team/p/a-guide-abcdefghij#heading-1";
function setup(content = "<p>before</p><p>neighbor</p>") {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ link: false }),
      Link.extend({
        addAttributes() {
          return { ...this.parent?.(), internal: { default: false } };
        },
      }),
      KnowledgeLinks,
    ],
    content,
  });
  editors.push(editor);
  editor.commands.setTextSelection(7);
  return editor;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
  vi.resetAllMocks();
});
describe("knowledge link targets", () => {
  it("recognizes document, office and attachment URLs, preserving anchors and versions", () => {
    expect(parseKnowledgeLink(url, window.location.origin)).toMatchObject({
      kind: "page",
      id: "abcdefghij",
      href: url,
    });
    const id = "11111111-2222-4333-8444-555555555555";
    expect(parseKnowledgeLink(`/p/${id}`, window.location.origin)?.id).toBe(id);
    expect(
      parseKnowledgeLink(
        `/api/office/download/${id}?version=3`,
        window.location.origin,
      )?.href,
    ).toContain("?version=3");
    expect(
      parseKnowledgeLink(`/api/files/${id}/report.pdf`, window.location.origin)
        ?.kind,
    ).toBe("attachment");
  });
  it("rejects other origins, lookalike hosts, credentials and non-content routes", () => {
    for (const value of [
      "https://evil.test/p/abcdefghij",
      "https://localhost.evil.test/p/abcdefghij",
      "javascript:alert(1)",
      "https://user@localhost:3000/p/abcdefghij",
      "/api/auth/callback",
      "/home",
      "not a URL",
    ])
      expect(parseKnowledgeLink(value, window.location.origin)).toBeNull();
  });
});
describe("asynchronous link insertion", () => {
  it("replaces selected text with the permission-resolved name and retains the exact target", async () => {
    vi.mocked(getPageById).mockResolvedValue({
      title: "搜索服务说明",
      nodeType: "office",
      fileExtension: "docx",
    } as any);
    const e = setup();
    e.commands.setTextSelection({ from: 1, to: 7 });
    expect(insertKnowledgeLink(e, url)).toBe(true);
    await settle();
    expect(e.state.doc.firstChild?.textContent).toBe("搜索服务说明");
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.doc.lastChild?.textContent).toBe("neighbor");
    expect(e.state.doc.firstChild?.firstChild?.marks[0].attrs.href).toBe(url);
  });
  it("handles a real paste before the generic link plugin can keep the old selected caption", async () => {
    vi.mocked(getPageById).mockResolvedValue({title:"粘贴解析后的名称"} as any);
    const e=setup();e.commands.setTextSelection({from:1,to:7});
    const preventDefault=vi.fn();const event={clipboardData:{getData:()=>url},preventDefault} as any;
    const handled=e.view.someProp("handlePaste",handler=>handler(e.view,event,undefined as any));
    expect(handled).toBe(true);await settle();expect(e.state.doc.firstChild?.textContent).toBe("粘贴解析后的名称");expect(preventDefault).toHaveBeenCalled();
  });
  it("maps the pending link through typing elsewhere", async () => {
    let resolve!: (v: any) => void;
    vi.mocked(getPageById).mockReturnValue(new Promise((r) => (resolve = r)));
    const e = setup();
    insertKnowledgeLink(e, url);
    e.commands.insertContentAt(1, "extra ");
    resolve({ title: "指南" });
    await settle();
    expect(e.state.doc.firstChild?.textContent).toBe("extra before指南");
    expect(knowledgeLinkKey.getState(e.state)?.size).toBe(0);
  });
  it("does not overwrite an edited, removed or undone link", async () => {
    let resolve!: (v: any) => void;
    vi.mocked(getPageById).mockReturnValue(new Promise((r) => (resolve = r)));
    const e = setup();
    insertKnowledgeLink(e, url);
    e.commands.insertContentAt(10, "edited");
    const before = e.getJSON();
    resolve({ title: "must not replace" });
    await settle();
    expect(e.getJSON()).toEqual(before);
  });
  it("undo removes the inserted link after its asynchronous name replacement", async () => {
    vi.mocked(getPageById).mockResolvedValue({ title: "已解析名称" } as any);
    const e = setup();
    const before = e.getJSON();
    insertKnowledgeLink(e, url);
    await settle();
    expect(e.state.doc.textContent).toContain("已解析名称");
    e.commands.undo();
    expect(e.getJSON()).toEqual(before);
  });
  it("a late response does not restore an undone link", async () => {
    let resolve!: (v: any) => void;
    vi.mocked(getPageById).mockReturnValue(new Promise((r) => (resolve = r)));
    const e = setup();
    const before = e.getJSON();
    insertKnowledgeLink(e, url);
    e.commands.undo();
    resolve({ title: "late" });
    await settle();
    expect(e.getJSON()).toEqual(before);
  });
  it("does not mutate an editor which was destroyed during resolution", async () => {
    let resolve!: (v: any) => void;
    vi.mocked(getPageById).mockReturnValue(new Promise((r) => (resolve = r)));
    const e = setup();
    insertKnowledgeLink(e, url);
    e.destroy();
    resolve({ title: "late" });
    await settle();
    expect(e.isDestroyed).toBe(true);
  });
  it("retains the URL when metadata is inaccessible and does not fetch external targets", async () => {
    vi.mocked(getPageById).mockRejectedValue(new Error("Forbidden"));
    const e = setup();
    insertKnowledgeLink(e, url);
    await settle();
    expect(e.state.doc.textContent).toContain(url);
    expect(insertKnowledgeLink(e, "https://outside.test/p/abcdefghij")).toBe(
      false,
    );
    expect(getPageById).toHaveBeenCalledTimes(1);
  });
  it("uses actual attachment metadata, handles editor disposal and respects read-only mode", async () => {
    vi.mocked(getAttachmentInfo).mockResolvedValue({
      fileName: "验收记录.PDF",
      fileExt: "pdf",
    } as any);
    const e = setup();
    insertKnowledgeLink(
      e,
      `/api/files/11111111-2222-4333-8444-555555555555/file.pdf`,
    );
    await settle();
    expect(e.state.doc.textContent).toContain("验收记录.PDF");
    e.setEditable(false);
    expect(insertKnowledgeLink(e, url)).toBe(false);
  });
});
