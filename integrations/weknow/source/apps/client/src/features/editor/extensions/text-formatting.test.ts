import { Editor, getSchema } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { describe, it, expect, afterEach } from "vitest";
import { TextFormatting } from "../../../../../../packages/editor-ext/src/lib/text-formatting";
import { toggleParagraphQuote } from "./paragraph-commands";
import { selectHandleParagraph } from "./block-format-target";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";

const extensions = [StarterKit, TextStyle, TextFormatting];
const editors: Editor[] = [];
function make(content = "<p>第一段文字</p><p>第二段文字</p>") {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions, content });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.innerHTML = "";
});

describe("shared text formatting", () => {
  it("changes only selected text and preserves existing bold marks", () => {
    const e = make("<p><strong>abc</strong>def</p>");
    e.commands.setTextSelection({ from: 1, to: 4 });
    e.commands.setTextSize("24px");
    e.commands.setTextFont("serif");
    expect(e.view.dom.querySelector("span")?.style.fontSize).toBe("24px");
    expect(e.view.dom.querySelector("span strong")?.textContent).toBe("abc");
    expect(e.view.dom.querySelector("span")?.nextSibling?.textContent).toBe(
      "def",
    );
  });
  it("resets size without clearing font or other marks", () => {
    const e = make("<p>abc</p>");
    e.commands.selectAll();
    e.chain().setTextSize("24px").setTextFont("serif").setTextSize(null).run();
    expect(e.getHTML()).not.toContain("font-size");
    expect(e.getHTML()).toContain("font-family: serif");
  });
  it("sets line height on an empty paragraph and keeps it on split", () => {
    const e = make("<p></p>");
    expect(e.commands.setParagraphLineHeight("2")).toBe(true);
    expect(e.state.doc.firstChild?.attrs.lineHeight).toBe("2");
    e.commands.insertContent("abc");
    e.commands.splitBlock();
    expect(e.state.doc.lastChild?.attrs.lineHeight).toBe("2");
  });
  it("formats only selected paragraphs, including list content", () => {
    const e = make(
      "<p>before</p><ul><li><p>one</p><p>two</p></li></ul><p>after</p>",
    );
    expect(selectHandleParagraph(e.view, e.view.dom.querySelector("li")!)).toBe(
      true,
    );
    expect(
      e.state.doc.textBetween(e.state.selection.from, e.state.selection.to),
    ).toBe("one");
    e.chain().setTextSize("20px").setParagraphLineHeight("1.75").run();
    expect(e.view.dom.querySelectorAll('[style*="line-height"]')).toHaveLength(
      1,
    );
    expect(e.view.dom.querySelectorAll('[style*="font-size"]')).toHaveLength(1);
  });
  it("applies a height across multiple blocks and supports undo", () => {
    const e = make();
    e.commands.selectAll();
    e.commands.setParagraphLineHeight("2.5");
    expect(
      e.state.doc.content.content.every((n) => n.attrs.lineHeight === "2.5"),
    ).toBe(true);
    e.commands.undo();
    expect(e.getHTML()).not.toContain("line-height");
  });
  it("round trips through HTML, JSON and collaborative Yjs storage", () => {
    const e = make();
    e.commands.setTextSelection({ from: 1, to: 6 });
    e.chain()
      .setTextSize("28px")
      .setTextFont("monospace")
      .setParagraphLineHeight("1.5")
      .run();
    const ydoc = prosemirrorJSONToYDoc(getSchema(extensions), e.getJSON());
    const json = yDocToProsemirrorJSON(ydoc);
    const other = make();
    other.commands.setContent(json);
    expect(other.getJSON()).toEqual(e.getJSON());
    const html = other.getHTML();
    other.commands.setContent(html);
    expect(other.getHTML()).toEqual(html);
    ydoc.destroy();
  });
  it("rejects invalid sizes, heights and CSS injection without mutation", () => {
    const e = make();
    const before = e.getJSON();
    for (const size of ["0px", "100000px", "12px; color:red", "2em"])
      expect(e.commands.setTextSize(size)).toBe(false);
    for (const height of ["0", "4", "20px", "1;display:none"])
      expect(e.commands.setParagraphLineHeight(height)).toBe(false);
    expect(e.commands.setTextFont("url(https://evil.invalid)")).toBe(false);
    expect(e.getJSON()).toEqual(before);
  });
  it("omits invalid stored attributes from HTML", () => {
    const e = make();
    e.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { lineHeight: "999" },
          content: [
            {
              type: "text",
              text: "safe",
              marks: [
                {
                  type: "textStyle",
                  attrs: { fontSize: "999px", fontFamily: "url(evil)" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(e.getHTML()).not.toContain("style=");
  });
  it("can reopen the paragraph menu on a code block and convert back without losing text", () => {
    const e = make("<pre><code>const value = 1;</code></pre><p>neighbor</p>");
    expect(
      selectHandleParagraph(e.view, e.view.dom.querySelector("pre")!),
    ).toBe(true);
    expect(
      e.state.doc.textBetween(e.state.selection.from, e.state.selection.to),
    ).toBe("const value = 1;");
    e.commands.setParagraph();
    expect(e.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(e.state.doc.firstChild?.textContent).toBe("const value = 1;");
    expect(e.state.doc.lastChild?.textContent).toBe("neighbor");
  });
  it("rejects stale and read-only targets while supporting atomic blocks", () => {
    const e = make("<p>one</p><hr>");
    expect(selectHandleParagraph(e.view, document.createElement("p"))).toBe(
      false,
    );
    expect(selectHandleParagraph(e.view, e.view.dom.querySelector("hr")!)).toBe(true);
    expect(e.state.selection.to - e.state.selection.from).toBe(1);
    e.setEditable(false);
    expect(selectHandleParagraph(e.view, e.view.dom.querySelector("p")!)).toBe(
      false,
    );
  });
  it.each([
    "<p>ordinary</p>",
    "<h1>heading</h1>",
    "<ol><li><p>listed</p></li></ol>",
  ])(
    "converts the target to a quote without changing its neighbor: %s",
    (html) => {
      const e = make(html + "<p>neighbor</p>");
      const target = e.view.dom.firstElementChild!;
      expect(
        selectHandleParagraph(
          e.view,
          target.tagName === "OL" ? target.querySelector("li")! : target,
        ),
      ).toBe(true);
      expect(toggleParagraphQuote(e)).toBe(true);
      expect(e.isActive("blockquote")).toBe(true);
      expect(e.state.doc.lastChild?.type.name).toBe("paragraph");
      expect(e.state.doc.lastChild?.textContent).toBe("neighbor");
      e.commands.toggleBlockquote();
      expect(e.isActive("blockquote")).toBe(false);
    },
  );
});
