import { atom } from "jotai";
import { Editor } from "@tiptap/core";
import { getRelativeSelection, ySyncPluginKey } from "@tiptap/y-tiptap";

export type ReviewDraft = {
  pageId: string;
  id: string;
  original: string;
  selection: any;
};
export const reviewDraftAtom = atom<{ value: ReviewDraft | null }>({
  value: null,
});
export function captureReview(
  editor: Editor,
  pageId: string,
): ReviewDraft | null {
  const { from, to, $from, $to } = editor.state.selection;
  if (
    from === to ||
    !$from.sameParent($to) ||
    to - from > 8000 ||
    $from.parent.type.name === "codeBlock"
  )
    return null;
  const binding = ySyncPluginKey.getState(editor.state)?.binding;
  if (!binding) return null;
  const selection = getRelativeSelection(binding, editor.state);
  return {
    pageId,
    id: crypto.randomUUID(),
    original: editor.state.doc.textBetween(from, to),
    selection: { anchor: selection.anchor, head: selection.head },
  };
}
