import { describe, expect, it } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { blockInsertItems, insertBelowBlock } from "./block-insert-commands";
const command = {
  title: "Heading 1",
  icon: null,
  description: "",
  searchTerms: [],
  command: ({ editor, range }: any) =>
    editor.chain().deleteRange(range).setHeading({ level: 1 }).run(),
};
describe("paragraph insertion", () => {
  it("uses the active slash registry and filters unavailable commercial entries", () => {
    const registry = {
      basic: [command, { ...command, title: "Base", requiresBases: true }],
    };
    const items = ({ query }: any) => (query === "none" ? {} : registry);
    const e = new Editor({
      extensions: [
        StarterKit,
        Extension.create({
          name: "slash-command",
          addOptions: () => ({ suggestion: { items } }),
        }),
      ],
    });
    expect(
      Object.values(blockInsertItems(e, "", false))
        .flat()
        .map((i) => i.title),
    ).toEqual(["Heading 1"]);
    expect(blockInsertItems(e, "none", false)).toEqual({});
    e.destroy();
  });
  it("inserts below a populated paragraph without converting or deleting its text", () => {
    const e = new Editor({
      extensions: [StarterKit],
      content: "<p>Keep all this text</p><p>Neighbor</p>",
    });
    e.commands.setTextSelection({ from: 1, to: 10 });
    expect(insertBelowBlock(e, command)).toBe(true);
    expect(e.state.doc.child(0).textContent).toBe("Keep all this text");
    expect(e.state.doc.child(1).type.name).toBe("heading");
    expect(e.state.doc.child(2).textContent).toBe("Neighbor");
    e.destroy();
  });
  it("keeps a nested quote intact and places new content outside it", () => {
    const e = new Editor({
      extensions: [StarterKit],
      content: "<blockquote><p>Quote</p></blockquote><p>Neighbor</p>",
    });
    e.commands.setTextSelection(3);
    insertBelowBlock(e, command);
    expect(e.state.doc.child(0).type.name).toBe("blockquote");
    expect(e.state.doc.child(0).textContent).toBe("Quote");
    expect(e.state.doc.child(1).type.name).toBe("heading");
    e.destroy();
  });
  it("supports an atomic block selected at the document root", () => {
    const e = new Editor({
      extensions: [StarterKit],
      content: "<hr><p>Neighbor</p>",
    });
    e.commands.setNodeSelection(0);
    expect(insertBelowBlock(e, command)).toBe(true);
    expect(e.state.doc.child(0).type.name).toBe("horizontalRule");
    expect(e.state.doc.child(1).type.name).toBe("heading");
    expect(e.state.doc.lastChild?.textContent).toBe("Neighbor");
    e.destroy();
  });
  it("does not insert when read-only or disabled", () => {
    const e = new Editor({ extensions: [StarterKit], content: "<p>Keep</p>" });
    e.commands.setTextSelection(2);
    expect(insertBelowBlock(e, { ...command, disable: () => true })).toBe(
      false,
    );
    e.setEditable(false);
    expect(insertBelowBlock(e, command)).toBe(false);
    expect(e.state.doc.childCount).toBe(1);
    e.destroy();
  });
  it("undo removes only the inserted block, preserving the previous typing", () => {
    const e = new Editor({
      extensions: [StarterKit],
      content: "<p>原有内容</p>",
    });
    e.commands.setTextSelection(5);
    e.commands.insertContent("继续写作");
    const before = e.getJSON();
    insertBelowBlock(e, command);
    e.commands.undo();
    expect(e.getJSON()).toEqual(before);
    e.destroy();
  });
});
