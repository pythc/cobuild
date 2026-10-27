import { beforeAll, afterEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { Editor, Extension } from "@tiptap/core";
import { IconMinus } from "@tabler/icons-react";
import { StarterKit } from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { TextFormatting } from "../../../../../../../packages/editor-ext/src/lib/text-formatting";
import { BlockFormatMenu } from "./block-format-menu";
import { blockFormatMenuEditorAtom } from "../../atoms/block-format-menu-atom";
import { BLOCK_FORMAT_EVENT } from "../../extensions/block-format-target";

vi.mock("@/platform/core-only", () => ({
  Feature: { BASES: "bases" },
  useHasFeature: () => false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const resizeCallbacks = new Map<Element, () => void>();
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function () {
      return this.hasAttribute("aria-controls")
        ? new DOMRect(368, 200, 20, 24)
        : new DOMRect(0, 0, 1024, 768);
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function () {
      return [this.getBoundingClientRect()] as unknown as DOMRectList;
    },
  );
  globalThis.ResizeObserver = class {
    callback: () => void;
    targets: Element[] = [];
    constructor(callback: ResizeObserverCallback) {
      this.callback = () => callback([], this);
    }
    observe(target: Element) {
      this.targets.push(target);
      resizeCallbacks.set(target, this.callback);
    }
    unobserve(target: Element) {
      resizeCallbacks.delete(target);
    }
    disconnect() {
      this.targets.forEach((target) => resizeCallbacks.delete(target));
    }
  };
});
const editors: Editor[] = [];
afterEach(() => {
  cleanup();
  editors.splice(0).forEach((e) => e.destroy());
});
function setup() {
  const editor = new Editor({
    extensions: [
      StarterKit,
      TextStyle,
      TextFormatting,
      Extension.create({
        name: "slash-command",
        addOptions: () => ({
          suggestion: {
            items: ({ query }: { query: string }) =>
              "divider".includes(query.toLowerCase())
                ? {
                    basic: [
                      {
                        title: "Divider",
                        icon: IconMinus,
                        description: "",
                        searchTerms: [],
                        command: ({ editor, range }: any) =>
                          editor
                            .chain()
                            .deleteRange(range)
                            .setHorizontalRule()
                            .run(),
                      },
                    ],
                  }
                : {},
          },
        }),
      }),
    ],
    content: "<p>Selected paragraph</p><p>Neighbor</p>",
  });
  editors.push(editor);
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <MantineProvider env="test">
        <BlockFormatMenu editor={editor} />
      </MantineProvider>
    </Provider>,
  );
  const open = (left = 368) =>
    act(() => {
      editor.view.dom.dispatchEvent(
        new CustomEvent(BLOCK_FORMAT_EVENT, {
          detail: {
            left,
            top: 200,
            block: { left: 388, top: 200, right: 1000, bottom: 240 },
          },
        }),
      );
    });
  return { editor, store, view, open };
}
describe("paragraph menu lifecycle", () => {
  it("docks without document mutations, stays docked after reflow and restores layout on close", async () => {
    const { editor, open } = setup();
    const host = editor.view.dom.parentElement!;
    const previous = host.style.cssText,
      documentBefore = editor.getJSON();
    open(20);
    const sidebar = await screen.findByRole("dialog", {
      name: "Paragraph settings",
    });
    expect(sidebar.getAttribute("data-layout")).toBe("sidebar");
    expect(host.style.marginLeft).toBe("264px");
    act(() => editor.commands.setTextSelection(22));
    expect(
      screen.getByRole("dialog", { name: "Paragraph settings" }),
    ).toBeTruthy();
    fireEvent.scroll(sidebar);
    expect(
      screen.getByRole("dialog", { name: "Paragraph settings" }),
    ).toBeTruthy();
    expect(editor.getJSON()).toEqual(documentBefore);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(host.style.cssText).toBe(previous);
  });
  it("closes and restores layout when the surrounding app sidebar changes container width", () => {
    const { editor, open } = setup();
    const host = editor.view.dom.parentElement!;
    const container = host.parentElement ?? host;
    let width = 1024;
    container.getBoundingClientRect = () => new DOMRect(0, 0, width, 768);
    const previous = host.style.cssText;
    open(20);
    expect(host.style.marginLeft).toBe("264px");
    width = 800;
    act(() => resizeCallbacks.get(container)?.());
    expect(host.style.cssText).toBe(previous);
    expect(
      screen.queryByRole("dialog", { name: "Paragraph settings" }),
    ).toBeNull();
  });
  it("restores reserved layout when resized or unmounted", () => {
    const { editor, open, view } = setup();
    const host = editor.view.dom.parentElement!,
      previous = host.style.cssText;
    open(20);
    fireEvent.resize(window);
    expect(host.style.cssText).toBe(previous);
    open(20);
    view.unmount();
    expect(host.style.cssText).toBe(previous);
  });
  it("exposes insertion commands immediately without a search field and preserves the selected paragraph", async () => {
    const { editor, store, open } = setup();
    open();
    expect(screen.queryByRole("button", { name: "Insert below" })).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Search commands" }),
    ).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Divider" }));
    expect(editor.state.doc.child(0).textContent).toBe("Selected paragraph");
    expect(editor.state.doc.child(1).type.name).toBe("horizontalRule");
    expect(editor.state.doc.lastChild?.textContent).toBe("Neighbor");
    expect(store.get(blockFormatMenuEditorAtom).editor).toBeNull();
  });
  it("suppresses the text bubble while open and closes with Escape even when the editor has focus", () => {
    const { editor, store, open } = setup();
    open();
    expect(store.get(blockFormatMenuEditorAtom).editor).toBe(editor);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(store.get(blockFormatMenuEditorAtom).editor).toBeNull();
    expect(editor.view.dom.dataset.blockFormatOpen).toBeUndefined();
  });
  it("converts a paragraph to a quote through the actual menu action", async () => {
    const { editor, store, open } = setup();
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Quote" }));
    expect(editor.state.doc.firstChild?.type.name).toBe("blockquote");
    expect(editor.state.doc.lastChild?.textContent).toBe("Neighbor");
    expect(store.get(blockFormatMenuEditorAtom).editor).toBeNull();
  });
  it("ignores read-only editors and clears only its own state on unmount", () => {
    const { editor, store, view, open } = setup();
    editor.setEditable(false);
    open();
    expect(store.get(blockFormatMenuEditorAtom).editor).toBeNull();
    editor.setEditable(true);
    open();
    expect(store.get(blockFormatMenuEditorAtom).editor).toBe(editor);
    view.unmount();
    expect(store.get(blockFormatMenuEditorAtom).editor).toBeNull();
  });
  it("keeps font and spacing controls behind a compact secondary panel", async () => {
    const { open, store, editor } = setup();
    open();
    expect(screen.queryByRole("combobox", { name: "Font size" })).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "Text formatting" }),
    );
    expect(
      await screen.findByRole("combobox", { name: "Font size" }),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Line height" })).toBeTruthy();
    expect(store.get(blockFormatMenuEditorAtom).editor).toBe(editor);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("combobox", { name: "Font size" })).toBeNull();
    expect(screen.getByRole("button", { name: "Heading 1" })).toBeTruthy();
  });
});
