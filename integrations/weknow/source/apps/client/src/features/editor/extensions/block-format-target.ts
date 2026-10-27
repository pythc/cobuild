import { EditorView } from "@tiptap/pm/view";
import { TextSelection, NodeSelection } from "@tiptap/pm/state";

export const BLOCK_FORMAT_EVENT = "editor:block-format";
export type BlockFormatDetail = {
  left: number;
  top: number;
  block?: { left: number; top: number; right: number; bottom: number };
};

// A list/quote grip targets its first natural paragraph, not all paragraphs
// nested under that container. Other blocks (images, tables, code) keep dragging.
export function selectHandleParagraph(
  view: EditorView,
  element: Element,
): boolean {
  if (
    !view.editable ||
    !view.dom.contains(element) ||
    element.closest(".ProseMirror") !== view.dom
  )
    return false;
  const target = element.matches("p,h1,h2,h3,h4,h5,h6,pre")
    ? element
    : element.matches("li,blockquote")
      ? element.querySelector("p,h1,h2,h3,h4,h5,h6")
      : null;
  if (!target) {
    // Media and tables still offer insertion below, without pretending their
    // contents can be converted using text formatting commands.
    try {
      const pos = view.posAtDOM(element, 0);
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.isInline || !NodeSelection.isSelectable(node))
        return false;
      view.dispatch(
        view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)),
      );
      return true;
    } catch {
      return false;
    }
  }
  if (target.closest(".ProseMirror") !== view.dom) return false;
  const pos = view.posAtDOM(target, 0);
  const resolved = view.state.doc.resolve(pos);
  if (
    !["paragraph", "heading", "codeBlock"].includes(resolved.parent.type.name)
  )
    return false;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, resolved.start(), resolved.end()),
    ),
  );
  return true;
}
