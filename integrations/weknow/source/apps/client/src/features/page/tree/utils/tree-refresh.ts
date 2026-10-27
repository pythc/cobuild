import type { SpaceTreeNode } from "../types";

// The server snapshot is authoritative. Rebuild only expanded branches; hidden
// branches are lazy-loaded on the next expansion rather than retaining stale nodes.
export async function refreshExpandedTree(
  roots: SpaceTreeNode[],
  openIds: ReadonlySet<string>,
  loadChildren: (id: string) => Promise<SpaceTreeNode[]>,
): Promise<SpaceTreeNode[]> {
  async function visit(
    nodes: SpaceTreeNode[],
    ancestors: Set<string>,
  ): Promise<SpaceTreeNode[]> {
    return Promise.all(
      nodes
        .filter((n) => !ancestors.has(n.id))
        .map(async (node) => {
          const next = new Set(ancestors);
          next.add(node.id);
          const children =
            node.hasChildren && openIds.has(node.id)
              ? await visit(await loadChildren(node.id), next)
              : [];
          return { ...node, children };
        }),
    );
  }
  return visit(roots, new Set());
}

export function limitTreeRequests(limit = 4) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(load: () => Promise<T>): Promise<T> {
    if (active >= limit)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await load();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
