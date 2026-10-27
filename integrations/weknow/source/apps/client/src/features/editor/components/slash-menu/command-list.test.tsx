import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import CommandList from "./command-list";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
vi.mock("@/platform/core-only", () => ({
  Feature: { BASES: "BASES" },
  useHasFeature: () => false,
}));
Object.defineProperty(window, "matchMedia", {
  value: () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }),
});
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);
Element.prototype.scrollIntoView = vi.fn();
describe("Chinese input in slash menu", () => {
  it("does not execute a command when Enter confirms an IME composition", () => {
    const command = vi.fn();
    render(
      <MantineProvider>
        <CommandList
          items={{
            basic: [
              {
                title: "Quote",
                description: "",
                icon: () => <span />,
                searchTerms: [],
              },
            ] as any,
          }}
          command={command}
          editor={{}}
          range={{}}
        />
      </MantineProvider>,
    );
    fireEvent.keyDown(document, {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    expect(command).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Enter", isComposing: false });
    expect(command).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
