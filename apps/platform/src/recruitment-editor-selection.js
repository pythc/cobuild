import { Selection } from "@tiptap/pm/state";
export const mailEndSelection = (doc) => Selection.atEnd(doc);
export function insertMailContent(editor, content, { inline = false } = {}) {
  const selection = editor.state.selection,
    chain = editor.chain().focus();
  if (selection.node) {
    const payload =
      inline && !selection.$from.parent.inlineContent
        ? {
            type: "paragraph",
            content: Array.isArray(content) ? content : [content],
          }
        : content;
    return chain.insertContentAt(selection.to, payload).run();
  }
  return chain.insertContent(content).run();
}
