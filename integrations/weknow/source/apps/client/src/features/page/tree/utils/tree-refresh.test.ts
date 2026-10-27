import { describe, it, expect } from "vitest";
import { refreshExpandedTree, limitTreeRequests } from "./tree-refresh";
import { mergeRootTrees } from "./utils";
import type { SpaceTreeNode } from "../types";
const node = (
  id: string,
  more: Partial<SpaceTreeNode> = {},
): SpaceTreeNode => ({
  id,
  slugId: id,
  name: id,
  position: id,
  spaceId: "s",
  parentPageId: null,
  hasChildren: false,
  children: [],
  ...more,
});
describe("authoritative tree synchronization", () => {
  it("applies rename/order/deletion and does not keep a removed root", () => {
    const previous = [
      node("old"),
      node("keep", { children: [node("child")], hasChildren: true }),
    ];
    const result = mergeRootTrees(previous, [
      node("keep", { name: "renamed", position: "b", hasChildren: true }),
      node("new", { position: "a" }),
    ]);
    expect(result.map((n) => n.id)).toEqual(["new", "keep"]);
    expect(result[1].name).toBe("renamed");
    expect(result[1].children[0].id).toBe("child");
    expect(previous[1].name).toBe("keep");
  });
  it("drops cached descendants when an authoritative parent becomes empty", () => {
    expect(
      mergeRootTrees(
        [node("a", { children: [node("deleted")] })],
        [node("a")],
      )[0].children,
    ).toEqual([]);
  });
  it("refreshes nested expanded branches and clears stale collapsed branches", async () => {
    const requests: string[] = [];
    const result = await refreshExpandedTree(
      [
        node("a", { hasChildren: true }),
        node("b", { hasChildren: true, children: [node("stale")] }),
      ],
      new Set(["a", "a1"]),
      async (id) => {
        requests.push(id);
        return id === "a"
          ? [node("a1", { hasChildren: true }), node("a2")]
          : [node("fresh")];
      },
    );
    expect(requests).toEqual(["a", "a1"]);
    expect(result[0].children[0].children[0].id).toBe("fresh");
    expect(result[1].children).toEqual([]);
    expect(result[1].hasChildren).toBe(true);
  });
  it("does not publish a partial snapshot after a child request fails", async () => {
    const original = [
      node("a", { hasChildren: true, children: [node("old")] }),
    ];
    await expect(
      refreshExpandedTree(original, new Set(["a"]), async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow();
    expect(original[0].children[0].id).toBe("old");
  });
  it("bounds concurrent child requests, including a rejected request", async () => {
    const limit = limitTreeRequests(2);
    let active = 0,
      max = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        limit(async () => {
          active++;
          max = Math.max(max, active);
          await new Promise((r) => setTimeout(r, 1));
          active--;
          if (i === 3) throw new Error("fixture");
          return i;
        }),
      ),
    );
    expect(max).toBe(2);
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(11);
  });
});
