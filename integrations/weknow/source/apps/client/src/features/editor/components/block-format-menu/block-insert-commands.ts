import { closeHistory } from "@tiptap/pm/history";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type { Editor } from "@tiptap/core";
import { TextSelection, NodeSelection } from "@tiptap/pm/state";
import type {
  SlashMenuGroupedItemsType,
  SlashMenuItemType,
} from "../slash-menu/types";

export function blockInsertItems(
  editor: Editor,
  query: string,
  hasBases: boolean,
): SlashMenuGroupedItemsType {
  // Use the active editor's registry, including its template exclusions.
  const slash = editor.extensionManager.extensions.find(
    (e) => e.name === "slash-command",
  );
  const items = slash?.options.suggestion?.items?.({ query, editor });
  if (!items || items instanceof Promise) return {};
  return Object.fromEntries(
    Object.entries(items as SlashMenuGroupedItemsType)
      .map(([group, values]) => [
        group,
        values.filter((item) => hasBases || !item.requiresBases),
      ])
      .filter(([, values]) => (values as SlashMenuItemType[]).length),
  );
}

export function insertBelowBlock(
  editor: Editor,
  item: SlashMenuItemType,
): boolean {
  if (editor.isDestroyed || !editor.isEditable || item.disable?.(editor))
    return false;
  const { $from } = editor.state.selection;
  if (!$from.depth && !(editor.state.selection instanceof NodeSelection))
    return false;
  // Keep a list, quote or table intact. New content belongs below the containing
  // top-level block, never in place of its selected paragraph text.
  const pos = $from.depth ? $from.after(1) : editor.state.selection.to;
  const paragraph = editor.schema.nodes.paragraph.create();
  const undoManager = yUndoPluginKey.getState(editor.state)?.undoManager;
  undoManager?.stopCapturing();
  const tr = closeHistory(editor.state.tr.insert(pos, paragraph));
  tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  editor.view.dispatch(tr);
  try {
    item.command({ editor, range: { from: pos + 1, to: pos + 1 } });
  } finally {
    undoManager?.stopCapturing();
  }
  return true;
}
