import { useEffect, useRef } from "react";
import { useAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { treeDataAtom } from "../atoms/tree-data-atom";
import { openTreeNodesAtom } from "../atoms/open-tree-nodes-atom";
import { buildTree } from "../utils/utils";
import { limitTreeRequests, refreshExpandedTree } from "../utils/tree-refresh";
import { getAllSidebarPages } from "@/features/page/services/page-service";
import localEmitter from "@/lib/local-emitter";

export function useSpaceTreeRefresh(spaceId: string) {
  const [, setTree] = useAtom(treeDataAtom);
  const [open] = useAtom(openTreeNodesAtom);
  const openRef = useRef(open);
  openRef.current = open;
  const queryClient = useQueryClient();
  useEffect(() => {
    let disposed = false,
      running = false,
      dirty = false,
      generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    const limit = limitTreeRequests();
    const openKey = () =>
      Object.keys(openRef.current)
        .filter((id) => openRef.current[id])
        .sort()
        .join(",");
    const refresh = async () => {
      if (disposed) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      dirty = false;
      const version = generation,
        expanded = openKey();
      try {
        const response = await getAllSidebarPages({ spaceId });
        const children = new Map<
          string,
          Awaited<ReturnType<typeof getAllSidebarPages>>
        >();
        const snapshot = await refreshExpandedTree(
          buildTree(response.pages.flatMap((page) => page.items)),
          new Set(expanded.split(",").filter(Boolean)),
          (id) =>
            limit(async () => {
              const result = await getAllSidebarPages({ spaceId, pageId: id });
              children.set(id, result);
              return buildTree(result.pages.flatMap((page) => page.items));
            }),
        );
        if (disposed) return;
        if (version !== generation || expanded !== openKey()) {
          dirty = true;
          return;
        }
        // Invalidate hidden cached branches as well. Opening one later must not
        // reuse the previous 30-minute child list.
        await queryClient.invalidateQueries({
          queryKey: ["sidebar-pages"],
          refetchType: "none",
          predicate: (q) =>
            (q.queryKey[1] as { spaceId?: string })?.spaceId === spaceId,
        });
        if (disposed || version !== generation) {
          dirty = true;
          return;
        }
        for (const [pageId, result] of children)
          queryClient.setQueryData(
            ["sidebar-pages", { spaceId, pageId }],
            result,
          );
        queryClient.setQueryData(["root-sidebar-pages", spaceId], response);
        setTree((previous) => [
          ...previous.filter((node) => node.spaceId !== spaceId),
          ...snapshot,
        ]);
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response
          ?.status;
        if (!disposed && [401, 403, 404].includes(status)) {
          setTree((previous) =>
            previous.filter((node) => node.spaceId !== spaceId),
          );
          void queryClient.invalidateQueries({ queryKey: ["spaces"] });
        }
        // Temporary failures retain the last good tree; focus, reconnect or the
        // periodic visible-page check will reconcile it without a new login.
      } finally {
        running = false;
        if (!disposed && dirty) {
          clearTimeout(timer);
          timer = setTimeout(() => {
            void refresh();
          }, 150);
        }
      }
    };
    const schedule = (event?: { spaceId?: string }) => {
      if (event?.spaceId && event.spaceId !== spaceId) return;
      generation++;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh();
      }, 150);
    };
    const wake = () => {
      if (document.visibilityState !== "hidden") schedule();
    };
    localEmitter.on("page-tree-refresh", schedule);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    const interval = setInterval(wake, 60_000);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(interval);
      localEmitter.off("page-tree-refresh", schedule);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [spaceId, queryClient, setTree]);
}
