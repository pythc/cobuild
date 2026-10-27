import { atom } from "jotai";
import type { Editor } from "@tiptap/core";

// Scope to the editor instance so a template/dialog cannot hide another menu.
export const blockFormatMenuEditorAtom = atom({ editor: null as Editor | null });
