import type { Editor } from "@tiptap/core";

export function toggleParagraphQuote(editor: Editor): boolean {
  if (!editor.isEditable) return false;
  return editor
    .chain()
    .focus()
    .command(({ state, commands }) => {
      let needsConversion = false;
      state.doc.nodesBetween(
        state.selection.from,
        state.selection.to,
        (node) => {
          if (node.isTextblock && node.type.name !== "paragraph")
            needsConversion = true;
        },
      );
      // setParagraph on an existing paragraph falls back to clearNodes upstream,
      // which can lift list items and invalidate the intended quote selection.
      return needsConversion ? commands.setParagraph() : true;
    })
    .command(({ commands, state, chain }) => {
      if (commands.toggleBlockquote()) return true;
      // A list item must start with a paragraph, so its first paragraph cannot
      // be wrapped in a quote in place. Lift that item, keeping adjacent items.
      for (let depth = state.selection.$from.depth; depth > 0; depth--) {
        const type = state.selection.$from.node(depth).type.name;
        if (type === "listItem" || type === "taskItem") {
          return chain().liftListItem(type).toggleBlockquote().run();
        }
      }
      return false;
    })
    .run();
}
