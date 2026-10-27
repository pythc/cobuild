import api from "@/lib/api-client";
import { saveAs } from "file-saver";
import type { IPage } from "@/features/page/types/page.types";
export type Directory = { spaceId: string; parentPageId?: string | null };
export const errorMessage = (e: any) =>
  e?.response?.data?.message || e?.message || "操作失败，请重试";
export async function officePost<T = any>(
  path: string,
  body: any,
  options?: any,
): Promise<T> {
  const response = await api.post(path, body, options);
  return response.data;
}
export async function listDirectory(target: Directory) {
  const items: IPage[] = [];
  let cursor: string | undefined;
  let officeEnabled = false;
  do {
    const data = await officePost<any>("/office/list", { ...target, cursor });
    items.push(...data.items);
    cursor = data.nextCursor;
    officeEnabled = data.officeEnabled;
  } while (cursor);
  return {
    items: items.sort((a, b) =>
      (a.position || "") < (b.position || "")
        ? -1
        : (a.position || "") > (b.position || "")
          ? 1
          : 0,
    ),
    officeEnabled,
  };
}
export async function downloadFile(
  pageId: string,
  name: string,
  version?: number,
) {
  const response = await fetch(
    `/api/office/download/${pageId}${version ? "?version=" + version : ""}`,
    { credentials: "same-origin" },
  );
  if (!response.ok) throw new Error("下载失败，请刷新后重试");
  saveAs(await response.blob(), name);
}
export async function downloadResult(taskId: string, name: string) {
  const response = await fetch("/api/office/result/" + taskId, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("导出尚未完成或已无访问权限");
  saveAs(await response.blob(), name);
}
export function uploadFile(
  file: File,
  target: Directory,
  progress: (percent: number) => void,
  replace?: { pageId: string; expectedVersion: number },
) {
  const body = new FormData();
  if (target.spaceId) body.append("spaceId", target.spaceId);
  if (target.parentPageId) body.append("parentPageId", target.parentPageId);
  if (replace) {
    body.append("pageId", replace.pageId);
    body.append("expectedVersion", String(replace.expectedVersion));
  }
  body.append("file", file);
  return officePost<IPage>("/office/upload", body, {
    onUploadProgress: (e) =>
      progress(
        e.total ? Math.min(99, Math.round((e.loaded / e.total) * 100)) : 0,
      ),
  });
}
export function modernExtension(ext?: string) {
  if (["doc", "docx", "odt", "rtf", "txt"].includes(ext || "")) return "docx";
  if (["xls", "xlsx", "ods", "csv"].includes(ext || "")) return "xlsx";
  if (["ppt", "pptx", "odp"].includes(ext || "")) return "pptx";
  return null;
}
