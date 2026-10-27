import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
vi.mock("@/features/page/services/page-service", () => ({
  getAllSidebarPages: vi.fn(),
}));
import { getAllSidebarPages } from "@/features/page/services/page-service";
import { useSpaceTreeRefresh } from "./use-space-tree-refresh";
import { treeDataAtom } from "../atoms/tree-data-atom";
import { openTreeNodesAtom } from "../atoms/open-tree-nodes-atom";
import localEmitter from "@/lib/local-emitter";
const page = (id: string, title = id) => ({
  id,
  slugId: id,
  title,
  position: id,
  spaceId: "s",
  parentPageId: null,
  hasChildren: false,
});
const response = (items: any[]) => ({
  pages: [{ items, meta: {} }],
  pageParams: [undefined],
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
function fixture() {
  vi.useFakeTimers();
  const store = createStore();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </Provider>
  );
  return { store, client, wrapper };
}
const advance = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
};
describe("live tree snapshot lifecycle", () => {
  it("updates expanded children after a server invalidation, including rename and deletion", async () => {
    const f = fixture();
    f.store.set(openTreeNodesAtom, { root: true });
    let phase = 0;
    vi.mocked(getAllSidebarPages).mockImplementation(
      async (params: any) =>
        response(
          params.pageId
            ? phase
              ? [page("new")]
              : [page("old")]
            : [
                {
                  ...page("root", phase ? "renamed" : "root"),
                  hasChildren: true,
                },
              ],
        ) as any,
    );
    renderHook(() => useSpaceTreeRefresh("s"), { wrapper: f.wrapper });
    await advance();
    expect(f.store.get(treeDataAtom)[0].children[0].id).toBe("old");
    phase = 1;
    act(() => localEmitter.emit("page-tree-refresh", { spaceId: "s" }));
    await advance();
    const root = f.store.get(treeDataAtom)[0];
    expect(root.name).toBe("renamed");
    expect(root.children.map((n) => n.id)).toEqual(["new"]);
  });
  it("does not apply an older response after another invalidation arrives", async () => {
    const f = fixture();
    let finish: (v: any) => void;
    vi.mocked(getAllSidebarPages)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }) as any,
      )
      .mockResolvedValue(response([page("fresh")]) as any);
    renderHook(() => useSpaceTreeRefresh("s"), { wrapper: f.wrapper });
    await advance();
    act(() => localEmitter.emit("page-tree-refresh", { spaceId: "s" }));
    await advance();
    await act(async () => {
      finish(response([page("stale")]));
    });
    expect(f.store.get(treeDataAtom)).toEqual([]);
    await advance();
    expect(f.store.get(treeDataAtom).map((n) => n.id)).toEqual(["fresh"]);
  });
  it("ignores old-space responses after navigation and removes listeners on unmount", async () => {
    const f = fixture();
    let finish: (v: any) => void;
    vi.mocked(getAllSidebarPages)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }) as any,
      )
      .mockResolvedValue(
        response([{ ...page("other"), spaceId: "other" }]) as any,
      );
    const hook = renderHook(({ spaceId }) => useSpaceTreeRefresh(spaceId), {
      wrapper: f.wrapper,
      initialProps: { spaceId: "s" },
    });
    await advance();
    hook.rerender({ spaceId: "other" });
    await advance();
    await act(async () => {
      finish(response([page("stale")]));
    });
    expect(f.store.get(treeDataAtom).map((n) => n.id)).toEqual(["other"]);
    const calls = vi.mocked(getAllSidebarPages).mock.calls.length;
    hook.unmount();
    act(() => localEmitter.emit("page-tree-refresh", {}));
    await advance();
    expect(getAllSidebarPages).toHaveBeenCalledTimes(calls);
  });
  it("preserves a last-good snapshot on outage but clears it when permission is revoked", async () => {
    const f = fixture();
    vi.mocked(getAllSidebarPages)
      .mockResolvedValueOnce(response([page("current")]) as any)
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ response: { status: 403 } });
    renderHook(() => useSpaceTreeRefresh("s"), { wrapper: f.wrapper });
    await advance();
    act(() => localEmitter.emit("page-tree-refresh", {}));
    await advance();
    expect(f.store.get(treeDataAtom)).toHaveLength(1);
    act(() => localEmitter.emit("page-tree-refresh", {}));
    await advance();
    expect(f.store.get(treeDataAtom)).toEqual([]);
  });
});
