import { describe, expect, it } from "vitest";
import { blockMenuPlacement, BLOCK_MENU_WIDTH } from "./block-menu-placement";

describe("block menu placement", () => {
  it("keeps the floating menu entirely in the left gutter", () => {
    const result = blockMenuPlacement({ left: 368, top: 200 }, 720);
    expect(result.mode).toBe("floating");
    expect(result.position).toBe("left-start");
    expect(result.left - BLOCK_MENU_WIDTH - 8).toBeGreaterThanOrEqual(8);
  });
  it("uses a sidebar when there is not enough left gutter, including near the bottom", () => {
    for (const top of [120, 620]) {
      expect(blockMenuPlacement({ left: 20, top }, 720).mode).toBe("sidebar");
    }
  });
  it("does not leave the threshold pixel overlapping the viewport edge", () => {
    expect(blockMenuPlacement({ left: 247, top: 200 }, 720).mode).toBe(
      "sidebar",
    );
    expect(blockMenuPlacement({ left: 248, top: 200 }, 720).mode).toBe(
      "floating",
    );
  });
});
