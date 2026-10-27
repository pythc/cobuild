import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { buildTree } from "@/features/page/tree/utils/utils";
import { atom, useAtom, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Group,
  Paper,
  Progress,
  Text,
  Stack,
  Button,
} from "@mantine/core";
import { IconUpload, IconX, IconCheck, IconRefresh } from "@tabler/icons-react";
import { useParams } from "react-router-dom";
import { usePageQuery } from "@/features/page/queries/page-query";
import { extractPageSlugId } from "@/lib";
import { FileIcon } from "./file-icon";
import { Directory, errorMessage, uploadFile } from "./office-api";
type Upload = {
  id: string;
  file: File;
  target: Directory;
  name: string;
  progress: number;
  state: "queued" | "uploading" | "done" | "failed";
  error?: string;
};
const uploadsAtom = atom<Upload[]>([]);
export function useFileUploads() {
  const set = useSetAtom(uploadsAtom),
    tree = useSetAtom(treeDataAtom),
    query = useQueryClient();
  const run = useCallback(
    async (item: Upload) => {
      const update = (v: Partial<Upload>) =>
        set((rows) =>
          rows.map((row) => (row.id === item.id ? { ...row, ...v } : row)),
        );
      update({ state: "uploading", progress: 0, error: undefined });
      try {
        const page = await uploadFile(item.file, item.target, (progress) =>
          update({ progress }),
        );
        tree((rows) =>
          treeModel.find(rows, page.id)
            ? rows
            : treeModel.insert(
                rows,
                page.parentPageId || null,
                buildTree([page])[0],
              ),
        );
        update({ state: "done", progress: 100 });
        await query.invalidateQueries({ queryKey: ["office-directory"] });
        await query.invalidateQueries({ queryKey: ["root-sidebar-pages"] });
        await query.invalidateQueries({ queryKey: ["sidebar-pages"] });
        await query.invalidateQueries({ queryKey: ["pages"] });
      } catch (e) {
        update({ state: "failed", error: errorMessage(e) });
      }
    },
    [set, tree, query],
  );
  const enqueue = useCallback(
    async (files: File[], target: Directory) => {
      const items = files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        target: { ...target },
        name: file.name,
        progress: 0,
        state: "queued" as const,
      }));
      set((rows) => [...rows, ...items]);
      // Sequential uploads avoid exhausting memory when a user drops many files.
      for (const item of items) await run(item);
    },
    [set, run],
  );
  return { enqueue, retry: run };
}
export function FileUploadTray() {
  const [rows, set] = useAtom(uploadsAtom),
    { retry } = useFileUploads();
  if (!rows.length) return null;
  return (
    <Paper
      withBorder
      shadow="md"
      radius="lg"
      p="md"
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        width: "min(350px, calc(100vw - 40px))",
        zIndex: 450,
        maxHeight: 330,
        overflow: "auto",
      }}
    >
      <Group justify="space-between" mb="sm">
        <Text fw={600} size="sm">
          文件上传
        </Text>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="清除已完成上传"
          onClick={() =>
            set((r) =>
              r.filter(
                (v) =>
                  v.state === "queued" ||
                  v.state === "uploading" ||
                  v.state === "failed",
              ),
            )
          }
        >
          <IconX size={16} />
        </ActionIcon>
      </Group>
      <Stack gap="md">
        {rows.map((row) => (
          <div key={row.id}>
            <Group wrap="nowrap" gap="xs">
              <FileIcon type="file" ext={row.name.split(".").pop()} size={18} />
              <Text size="sm" truncate style={{ flex: 1 }}>
                {row.name}
              </Text>
              {row.state === "done" ? (
                <IconCheck size={16} color="var(--mantine-color-teal-6)" />
              ) : row.state === "failed" ? (
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  aria-label={"重试上传 " + row.name}
                  onClick={() => void retry(row)}
                >
                  <IconRefresh size={16} />
                </ActionIcon>
              ) : (
                <Text size="xs" c="dimmed">
                  {row.progress}%
                </Text>
              )}
            </Group>
            {row.state !== "done" && (
              <Progress
                size={3}
                mt={6}
                value={row.progress}
                color={row.state === "failed" ? "red" : undefined}
              />
            )}
            <Text
              size="xs"
              c={row.state === "failed" ? "red" : "dimmed"}
              mt={4}
            >
              {row.error ||
                (row.state === "queued"
                  ? "等待上传"
                  : row.state === "uploading"
                    ? "正在上传"
                    : "已上传")}
            </Text>
          </div>
        ))}
      </Stack>
      <Button
        variant="subtle"
        size="xs"
        mt="sm"
        onClick={() =>
          set((r) =>
            r.filter((v) => v.state === "queued" || v.state === "uploading"),
          )
        }
      >
        清除记录
      </Button>
    </Paper>
  );
}
export function FileDropZone({
  spaceId,
  canEdit,
}: {
  spaceId: string;
  canEdit: boolean;
}) {
  const { pageSlug } = useParams(),
    { data: page } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const { enqueue } = useFileUploads(),
    [dragging, setDragging] = useState(false),
    depth = useRef(0);
  const parentPageId =
    page?.spaceId === spaceId
      ? ["file", "office"].includes(page.nodeType || "")
        ? page.parentPageId
        : page.id
      : null;
  useEffect(() => {
    const isFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    // Text-editor drops remain document attachments. Sidebar/file-browser drops are directory files.
    const inEditor = (e: DragEvent) =>
      e.target instanceof Element && !!e.target.closest(".tiptap");
    const enter = (e: DragEvent) => {
      if (isFiles(e) && !inEditor(e)) {
        e.preventDefault();
        depth.current++;
        if (canEdit) setDragging(true);
      }
    };
    const over = (e: DragEvent) => {
      if (isFiles(e) && !inEditor(e)) {
        e.preventDefault();
        if (e.dataTransfer)
          e.dataTransfer.dropEffect = canEdit ? "copy" : "none";
      }
    };
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      depth.current = 0;
      setDragging(false);
      if (!isFiles(e) || inEditor(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!canEdit) return;
      const node =
        e.target instanceof Element
          ? e.target.closest("[data-directory-id]")
          : null;
      void enqueue(Array.from(e.dataTransfer?.files || []), {
        spaceId,
        parentPageId: node?.getAttribute("data-directory-id") || parentPageId,
      });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [spaceId, parentPageId, canEdit, enqueue]);
  return (
    <>
      {dragging && (
        <div
          style={{
            position: "fixed",
            inset: 12,
            zIndex: 500,
            pointerEvents: "none",
            background: "light-dark(rgba(245,248,255,.94),rgba(24,28,39,.94))",
            border: "2px dashed var(--mantine-primary-color-5)",
            borderRadius: 18,
            display: "grid",
            placeItems: "center",
          }}
        >
          <Stack align="center" gap="xs">
            <IconUpload size={42} stroke={1.4} />
            <Text size="lg" fw={600}>
              松开上传到「{parentPageId ? page?.title : "空间根目录"}」
            </Text>
          </Stack>
        </div>
      )}
      <FileUploadTray />
    </>
  );
}
