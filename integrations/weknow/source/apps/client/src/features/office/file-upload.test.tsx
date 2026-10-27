import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
const mocks = vi.hoisted(() => ({ upload: vi.fn(), page: vi.fn() }));
vi.mock("./office-api", () => ({
  uploadFile: mocks.upload,
  errorMessage: (e: any) => e.message,
}));
vi.mock("@/features/page/queries/page-query", () => ({
  usePageQuery: mocks.page,
}));
vi.mock("@/features/page/tree/utils/utils", () => ({
  buildTree: (pages: any[]) => pages,
}));
vi.mock("@/lib", () => ({ extractPageSlugId: () => "folder" }));
import { FileDropZone } from "./file-upload";
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })),
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.page.mockReturnValue({
    data: {
      id: "folder",
      title: "Folder",
      spaceId: "space",
      nodeType: "folder",
    },
  });
  mocks.upload.mockResolvedValue({ id: "file", parentPageId: "folder" });
});
afterEach(cleanup);
function mount(canEdit = true) {
  return render(
    <Provider>
      <QueryClientProvider client={new QueryClient()}>
        <MantineProvider>
          <MemoryRouter>
            <FileDropZone spaceId="space" canEdit={canEdit} />
            <div data-testid="directory" />
            <div data-directory-id="hovered-folder" data-testid="hovered" />
            <div className="tiptap" data-testid="editor" />
          </MemoryRouter>
        </MantineProvider>
      </QueryClientProvider>
    </Provider>,
  );
}
function drop(node: Element) {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", {
    value: { types: ["Files"], files: [new File(["test"], "test.txt")] },
  });
  fireEvent(node, e);
  return e;
}
describe("Directory drag upload", () => {
  it("captures the current folder when dropping on the browser surface", async () => {
    const view = mount();
    const e = drop(view.getByTestId("directory"));
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => expect(mocks.upload).toHaveBeenCalled());
    expect(mocks.upload.mock.calls[0][1]).toEqual({
      spaceId: "space",
      parentPageId: "folder",
    });
  });
  it("uses an explicitly hovered directory rather than the open folder", async () => {
    const view = mount();
    drop(view.getByTestId("hovered"));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalled());
    expect(mocks.upload.mock.calls[0][1].parentPageId).toBe("hovered-folder");
  });
  it("preserves native document attachment drop handling", () => {
    const view = mount();
    expect(drop(view.getByTestId("editor")).defaultPrevented).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("prevents a read-only file drop from navigating the browser without uploading", () => {
    const view = mount(false);
    expect(drop(view.getByTestId("directory")).defaultPrevented).toBe(true);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
