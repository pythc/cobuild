import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Typography from "@tiptap/extension-typography";
import { MathBlock, MathInline } from "./math";
import { insertBelowBlock } from "../components/block-format-menu/block-insert-commands";
import { NodeSelection } from "@tiptap/pm/state";

const editors: Editor[] = [];
function make(content = "<p>Keep</p>") {
  const editor = new Editor({
    extensions: [
      StarterKit,
      Typography,
      MathBlock.extend({ addNodeView: () => undefined }),
      MathInline.extend({ addNodeView: () => undefined }),
    ],
    content,
  });
  editors.push(editor);
  return editor;
}
function enter(editor: Editor, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
    shiftKey,
  });
  editor.view.dom.dispatchEvent(event);
}
function type(editor: Editor, text: string) {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (f) =>
      f(editor.view, from, to, char, () =>
        editor.state.tr.insertText(char, from, to),
      ),
    );
    if (!handled)
      editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
}
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
});
describe("equation insertion and Enter shortcut", () => {
  it.each(["Math block", "Math inline"])(
    "opens %s after inserting below a paragraph without deleting it",
    (title) => {
      const e = make("<p>Keep</p><p>Neighbor</p>");
      e.commands.setTextSelection({ from: 1, to: 4 });
      insertBelowBlock(e, {
        title,
        description: "",
        searchTerms: [],
        icon: null,
        command: ({ editor, range }) => {
          const chain = editor.chain().deleteRange(range);
          if (title === "Math block") chain.setMathBlock().run();
          else chain.setMathInline().run();
        },
      });
      expect(e.state.doc.firstChild?.textContent).toBe("Keep");
      expect(e.state.doc.lastChild?.textContent).toBe("Neighbor");
      expect(e.state.selection).toBeInstanceOf(NodeSelection);
      expect((e.state.selection as NodeSelection).node.type.name).toBe(
        title === "Math block" ? "mathBlock" : "mathInline",
      );
    },
  );
  it("waits for Enter when the closing $$ is typed, renders a block, and keeps a writable next line", () => {
    const e = make("<p></p>");
    type(e, "$$E=mc^2$$");
    expect(e.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(e.state.doc.textContent).toBe("$$E=mc^2$$");
    enter(e);
    expect(e.getJSON().content).toEqual([
      { type: "mathBlock", attrs: { text: "E=mc^2" } },
      { type: "paragraph" },
    ]);
    expect(e.state.selection.$from.parent.type.name).toBe("paragraph");
    e.commands.insertContent("Continue");
    expect(e.state.doc.lastChild?.textContent).toBe("Continue");
  });
  it("protects TeX from typography and Markdown input rules", () => {
    const e = make("<p></p>");
    const latex = String.raw`x^2 + y^3 -- \text{"cost"} + a_b_c + *x*`;
    type(e, "$$" + latex + "$$");
    expect(e.state.doc.textContent).toBe("$$" + latex + "$$");
    expect(e.state.doc.firstChild?.childCount).toBe(1);
    enter(e);
    expect(e.state.doc.firstChild?.attrs.text).toBe(latex);
  });
  it("converts pasted text on Enter and preserves escapes and operators", () => {
    const e = make("<p></p>");
    e.commands.insertContent("$$\\frac{a}{b} + \\text{cost \\$5}$$");
    enter(e);
    expect(e.state.doc.firstChild?.attrs.text).toBe(
      "\\frac{a}{b} + \\text{cost \\$5}",
    );
    const reloaded = make(e.getHTML());
    expect(reloaded.state.doc.firstChild?.attrs.text).toBe(
      "\\frac{a}{b} + \\text{cost \\$5}",
    );
  });
  it("preserves typed text through undo and redo", () => {
    const e = make("<p>$$x^2$$</p>");
    e.commands.setTextSelection(8);
    enter(e);
    expect(e.state.doc.firstChild?.type.name).toBe("mathBlock");
    e.commands.undo();
    expect(e.state.doc.textContent).toBe("$$x^2$$");
    e.commands.redo();
    expect(e.state.doc.firstChild?.attrs.text).toBe("x^2");
  });
  it.each([
    "<blockquote><p>$$x$$</p></blockquote>",
    "<ul><li><p>$$x$$</p></li></ul>",
  ])("converts inside %s without breaking its container", (content) => {
    const e = make(content);
    let end = 0;
    e.state.doc.descendants((n, p) => {
      if (n.type.name === "paragraph") end = p + 1 + n.content.size;
    });
    e.commands.setTextSelection(end);
    enter(e);
    expect(e.state.doc.firstChild?.type.name).not.toBe("mathBlock");
    let count = 0;
    e.state.doc.descendants((n) => {
      if (n.type.name === "mathBlock") {
        count++;
        expect(n.attrs.text).toBe("x");
      }
    });
    expect(count).toBe(1);
    expect(e.state.selection.$from.parent.type.name).toBe("paragraph");
  });
  it.each(["$$$$", "$$   $$", "$$x", "$$x$$ trailing"])(
    "does not convert incomplete or nonstandalone input %s",
    (text) => {
      const e = make("<p></p>");
      e.commands.insertContent(text);
      enter(e);
      expect(e.getJSON().content?.some((n) => n.type === "mathBlock")).toBe(
        false,
      );
    },
  );
  it("keeps an expression literal inside code blocks and inline code", () => {
    for (const html of [
      "<pre><code>$$x$$</code></pre>",
      "<p><code>$$x$$</code></p>",
    ]) {
      const e = make(html);
      e.commands.setTextSelection(6);
      enter(e);
      expect(e.getJSON().content?.some((n) => n.type === "mathBlock")).toBe(
        false,
      );
    }
  });
  it("does not convert when the caret is in the middle or a range is selected", () => {
    const e = make("<p>$$x$$</p>");
    e.commands.setTextSelection(3);
    enter(e);
    expect(e.getJSON().content?.some((n) => n.type === "mathBlock")).toBe(
      false,
    );
    e.commands.setContent("<p>$$x$$</p>");
    e.commands.setTextSelection({ from: 1, to: 6 });
    enter(e);
    expect(e.getJSON().content?.some((n) => n.type === "mathBlock")).toBe(
      false,
    );
  });
  it("keeps the existing inline shortcut in prose and legacy triple dollar block shortcut", () => {
    const e = make("<p></p>");
    type(e, "Before $$x$$");
    expect(e.state.doc.firstChild?.lastChild?.type.name).toBe("mathInline");
    const b = make("<p></p>");
    type(b, "$$$x$$$");
    expect(b.state.doc.firstChild?.type.name).toBe("mathBlock");
    expect(b.state.doc.firstChild?.attrs.text).toBe("x");
  });
  it("leaves Shift+Enter and IME confirmation alone", () => {
    const e = make("<p>$$x$$</p>");
    e.commands.setTextSelection(6);
    enter(e, true);
    expect(e.getJSON().content?.some((n) => n.type === "mathBlock")).toBe(
      false,
    );
    e.commands.setContent("<p>$$x$$</p>");
    e.commands.setTextSelection(6);
    Object.defineProperty(e.view, "composing", {
      configurable: true,
      value: true,
    });
    enter(e);
    expect(e.state.doc.firstChild?.type.name).toBe("paragraph");
  });
});
