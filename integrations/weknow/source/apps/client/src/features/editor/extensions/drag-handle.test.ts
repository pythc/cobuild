import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, it, expect, vi } from "vitest";
import GlobalDragHandle from "./drag-handle";
import { BLOCK_FORMAT_EVENT } from "./block-format-target";

describe("paragraph grip", () => {
  it("opens on click, keeps native drag data, and never opens after a drag", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = new Editor({ element: host, extensions: [StarterKit, GlobalDragHandle], content: "<p>first</p><p>second</p>" });
    const paragraph = editor.view.dom.querySelector("p")!;
    const original = document.elementsFromPoint;
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [paragraph, editor.view.dom] });
    const coords = vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: 0 });
    const open = vi.fn();
    editor.view.dom.addEventListener(BLOCK_FORMAT_EVENT, open);
    try {
      editor.view.dom.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 100 }));
      const grip = host.parentElement!.querySelector<HTMLElement>(".drag-handle")!;
      grip.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
      grip.click();
      expect(open).toHaveBeenCalledOnce();
      expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe("first");
      open.mockClear();
      editor.commands.setTextSelection(1);
      grip.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
      const dataTransfer = { clearData: vi.fn(), setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" };
      const drag = new MouseEvent("dragstart", { clientX: 100, clientY: 100 });
      Object.defineProperty(drag, "dataTransfer", { value: dataTransfer });
      grip.dispatchEvent(drag);
      expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "first");
      expect(editor.view.dragging?.slice.content.textBetween(0, editor.view.dragging.slice.content.size)).toBe("first");
      grip.click();
      expect(open).not.toHaveBeenCalled();
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(open).toHaveBeenCalledOnce();
    } finally {
      coords.mockRestore();
      Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: original });
      editor.destroy();
      host.remove();
    }
    expect(document.querySelector(".drag-handle")).toBeNull();
  });
});
