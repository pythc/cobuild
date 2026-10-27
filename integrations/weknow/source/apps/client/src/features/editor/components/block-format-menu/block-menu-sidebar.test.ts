import { describe, expect, it } from "vitest";
import {
  blockSidebarPlacement,
  reserveBlockSidebar,
  BLOCK_SIDEBAR_INSET,
} from "./block-menu-sidebar";

describe("block sidebar layout reservation", () => {
  it("reserves real layout width and restores the exact previous inline properties", () => {
    const host = document.createElement("div"),
      dom = document.createElement("div");
    host.append(dom);
    document.body.append(host);
    host.style.cssText = "margin-left: 12px !important; width: 90%; color: red";
    host.getBoundingClientRect = () => new DOMRect(90, 170, 880, 500);
    const before = host.style.cssText;
    const doc = dom.innerHTML;
    const release = reserveBlockSidebar(dom);
    expect(host.style.marginLeft).toBe(`${12 + BLOCK_SIDEBAR_INSET}px`);
    expect(host.style.width).toBe(`${880 - BLOCK_SIDEBAR_INSET}px`);
    expect(dom.innerHTML).toBe(doc);
    release();
    expect(host.style.cssText).toBe(before);
    host.remove();
  });
  it("uses the editor host's left edge and keeps a usable height at the bottom", () => {
    const host = document.createElement("div"),
      dom = document.createElement("div");
    host.append(dom);
    host.getBoundingClientRect = () => new DOMRect(90, 620, 880, 100);
    const placement = blockSidebarPlacement(dom, 720);
    expect(placement.left).toBe(90);
    expect(placement.top).toBe(360);
    expect(placement.maxHeight).toBe(352);
  });
});
