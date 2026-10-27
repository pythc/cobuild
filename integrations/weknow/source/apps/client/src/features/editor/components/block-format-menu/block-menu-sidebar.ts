import { BLOCK_MENU_WIDTH } from "./block-menu-placement";

export const BLOCK_SIDEBAR_INSET = BLOCK_MENU_WIDTH + 32;
export type BlockSidebarPlacement = {
  left: number;
  top: number;
  maxHeight: number;
};

export function blockSidebarPlacement(
  editorDom: HTMLElement,
  viewportHeight: number,
): BlockSidebarPlacement {
  const host = editorDom.parentElement ?? editorDom;
  const rect = host.getBoundingClientRect();
  const top = Math.max(8, Math.min(rect.top, viewportHeight - 360));
  return {
    left: Math.max(8, rect.left),
    top,
    maxHeight: Math.max(48, viewportHeight - top - 8),
  };
}

// Only reserve display space on EditorContent's host. Never move React-managed
// nodes or write presentation changes into ProseMirror / collaborative content.
export function reserveBlockSidebar(editorDom: HTMLElement): () => void {
  const host = editorDom.parentElement ?? editorDom;
  const props = ["margin-left", "width", "min-width", "box-sizing"];
  const previous = props.map((name) => [
    name,
    host.style.getPropertyValue(name),
    host.style.getPropertyPriority(name),
  ]);
  const rect = host.getBoundingClientRect();
  const margin = parseFloat(getComputedStyle(host).marginLeft) || 0;
  host.style.setProperty("margin-left", `${margin + BLOCK_SIDEBAR_INSET}px`);
  host.style.setProperty(
    "width",
    `${Math.max(0, rect.width - BLOCK_SIDEBAR_INSET)}px`,
  );
  host.style.setProperty("min-width", "0");
  host.style.setProperty("box-sizing", "border-box");
  return () => {
    for (const [name, value, priority] of previous) {
      if (value) host.style.setProperty(name, value, priority);
      else host.style.removeProperty(name);
    }
  };
}
