import { atom } from "jotai";
export type SaveState = {
  pageId: string;
  phase:
    | "loading"
    | "saving"
    | "local"
    | "saved"
    | "offline"
    | "auth"
    | "permission"
    | "error";
  localSaved: boolean;
  confirmedAt?: string;
};
export const saveStateAtom = atom<SaveState>({
  pageId: "",
  phase: "loading",
  localSaved: false,
});
export function saveLabel(s: SaveState) {
  if (s.phase === "saved") return "已保存到服务器";
  if (s.phase === "permission")
    return s.localSaved
      ? "权限已变化 · 本机副本已保留"
      : "权限已变化 · 请保留当前页面";
  if (s.phase === "auth")
    return s.localSaved
      ? "登录已失效 · 本机副本已保留"
      : "登录已失效 · 请保留当前页面";
  if (s.phase === "offline")
    return s.localSaved ? "离线 · 已保存到本机" : "离线 · 正在保留本机副本";
  if (s.phase === "error")
    return s.localSaved
      ? "同步待确认 · 本机副本已保留"
      : "本机保存失败 · 请保留当前页面";
  if (s.phase === "local") return "已保存到本机 · 等待同步";
  return s.phase === "loading" ? "正在加载文档" : "正在保存";
}
