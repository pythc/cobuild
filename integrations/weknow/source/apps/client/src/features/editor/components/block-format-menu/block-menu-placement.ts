import type { BlockFormatDetail } from "../../extensions/block-format-target";

export const BLOCK_MENU_WIDTH = 232;
const GAP = 8;
const EDGE = 8;

// Decide once when opening: later document reflow must not change the mode.
export function blockMenuPlacement(
  anchor: BlockFormatDetail,
  viewportHeight: number,
) {
  return {
    mode:
      anchor.left >= BLOCK_MENU_WIDTH + GAP + EDGE
        ? ("floating" as const)
        : ("sidebar" as const),
    position: "left-start" as const,
    left: anchor.left,
    top: anchor.top,
    width: 20,
    height: 24,
    maxHeight: Math.max(48, viewportHeight - 2 * EDGE),
  };
}
