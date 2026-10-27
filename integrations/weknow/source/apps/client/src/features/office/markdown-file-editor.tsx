import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Group,
  Loader,
  SegmentedControl,
  Text,
  Textarea,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconDeviceFloppy, IconDownload } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import { saveAs } from "file-saver";
import DOMPurify from "dompurify";
import { markdownToHtml } from "@docmost/editor-ext";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import { IPage } from "@/features/page/types/page.types";
import { buildPageUrl } from "@/features/page/page.utils";
import {
  errorMessage,
  listDirectory,
  officePost,
  uploadFile,
} from "./office-api";
import {
  encodeMarkdown,
  readMarkdown,
  MarkdownSource,
  MARKDOWN_LIMIT,
} from "./markdown-file-utils";
import classes from "./markdown-file-editor.module.css";

interface Draft extends MarkdownSource {
  savedText: string;
}
// Memory-only recovery for browser Back; account/page keys never share another user's draft.
// Nothing is sent or saved to the server before the explicit Save action.
const drafts = new Map<string, Draft>();
function remember(key: string, draft: Draft) {
  drafts.delete(key);
  drafts.set(key, draft);
  while (drafts.size > 16) drafts.delete(drafts.keys().next().value!);
}

export function MarkdownFileEditor({
  page,
  version,
  size,
  canEdit,
  name,
  onSaved,
}: {
  page: IPage;
  version: number;
  size: number;
  canEdit: boolean;
  name: string;
  onSaved: () => Promise<unknown>;
}) {
  const user = useAtomValue(userAtom),
    query = useQueryClient(),
    navigate = useNavigate();
  const key = `${user?.workspaceId}:${user?.id}:${page.id}`;
  const identityKey = useRef(key);
  identityKey.current = key;
  const sourceKey = [
    "markdown-source",
    user?.workspaceId,
    user?.id,
    page.id,
    version,
  ];
  const source = useQuery({
    queryKey: sourceKey,
    retry: false,
    enabled: !!user?.id,
    queryFn: ({ signal }) => readMarkdown(page.id, version, size, signal),
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });
  const directory = useQuery({
    queryKey: [
      "markdown-directory",
      user?.workspaceId,
      user?.id,
      page.spaceId,
      page.parentPageId,
    ],
    queryFn: () =>
      listDirectory({ spaceId: page.spaceId, parentPageId: page.parentPageId }),
    enabled: !!source.data,
  });
  const [draft, setDraft] = useState<Draft | null>(drafts.get(key) || null);
  const [draftKey, setDraftKey] = useState(key);
  const [mode, setMode] = useState("read"),
    [busy, setBusy] = useState(false);
  const dirty = !!draft && draft.text !== draft.savedText;
  const current = useRef({ draft, dirty, busy });
  current.current = { draft, dirty, busy };
  const saveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const deferred = useDeferredValue(draft?.text || "");
  function reset(data: MarkdownSource) {
    if (identityKey.current !== key) return;
    drafts.delete(key);
    setDraftKey(key);
    setDraft({ ...data, savedText: data.text });
  }
  useEffect(() => {
    if (!source.data || current.current.dirty || current.current.busy) return;
    if (
      current.current.draft &&
      current.current.draft.version > source.data.version
    )
      return;
    const recovery = drafts.get(key);
    if (recovery) setDraft(recovery);
    else reset(source.data);
  }, [source.data, key, busy]);
  useEffect(() => {
    // Identity changes must not retain another member's unsaved source on screen.
    const recovered =
      drafts.get(key) ||
      (source.data ? { ...source.data, savedText: source.data.text } : null);
    setDraft(recovered);
    setDraftKey(key);
    current.current.draft = recovered;
    current.current.dirty =
      !!recovered && recovered.text !== recovered.savedText;
    current.current.busy = false;
    setBusy(false);
  }, [key]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!current.current.dirty && !current.current.busy) return;
      event.preventDefault();
      event.returnValue = "";
    };
    let asking = false;
    const click = (event: MouseEvent) => {
      if (
        (!current.current.dirty && !current.current.busy) ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement;
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      const target = new URL(anchor.href, window.location.href);
      if (
        target.origin !== window.location.origin ||
        (target.pathname === window.location.pathname &&
          target.search === window.location.search)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (asking || current.current.busy) return;
      asking = true;
      const leave = () =>
        navigate(target.pathname + target.search + target.hash);
      modals.open({
        title: "离开前保存修改？",
        centered: true,
        onClose: () => {
          asking = false;
        },
        children: (
          <>
            <Text size="sm" mb="lg">
              Markdown 的修改尚未保存。
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => modals.closeAll()}>
                继续编辑
              </Button>
              <Button
                variant="subtle"
                onClick={() => {
                  drafts.delete(key);
                  modals.closeAll();
                  leave();
                }}
              >
                不保存并离开
              </Button>
              <Button
                onClick={async () => {
                  if (await saveRef.current()) {
                    modals.closeAll();
                    leave();
                  }
                }}
              >
                保存并离开
              </Button>
            </Group>
          </>
        ),
      });
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    const shortcut = (event: KeyboardEvent) => {
      if (
        canEdit &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
      window.removeEventListener("keydown", shortcut);
    };
  }, [key, navigate, canEdit]);
  const html = useMemo(() => {
    const safe = DOMPurify.sanitize(markdownToHtml(deferred) as string, {
      FORBID_TAGS: ["iframe", "style", "form", "script", "object", "embed"],
      FORBID_ATTR: ["style"],
    });
    const dom = new DOMParser().parseFromString(safe, "text/html");
    for (const el of dom.querySelectorAll("a[href], img[src]")) {
      const attr = el.tagName === "IMG" ? "src" : "href",
        value = el.getAttribute(attr) || "";
      if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value)) continue;
      let filename: string;
      try {
        filename = decodeURIComponent(value.split("#")[0].replace(/^\.\//, ""));
      } catch {
        continue;
      }
      const matches = (directory.data?.items || []).filter((p) => {
        const title = p.title || "";
        const full =
          p.fileExtension &&
          !title.toLowerCase().endsWith("." + p.fileExtension)
            ? title + "." + p.fileExtension
            : title;
        return full === filename;
      });
      if (matches.length !== 1) continue;
      const file = matches[0];
      if (
        el.tagName === "IMG" &&
        ["png", "jpg", "jpeg", "gif", "webp"].includes(file.fileExtension || "")
      )
        el.setAttribute(attr, `/api/office/download/${file.id}?inline=1`);
      else if (el.tagName === "A")
        el.setAttribute(
          attr,
          buildPageUrl(page.space.slug, file.slugId, file.title) +
            (value.includes("#")
              ? "#" + value.split("#").slice(1).join("#")
              : ""),
        );
    }
    for (const link of dom.querySelectorAll("a[href]")) {
      if (/^https?:\/\//.test(link.getAttribute("href") || "")) {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
      }
    }
    return dom.body.innerHTML;
  }, [deferred, directory.data, page.space.slug]);
  const downloadDraft = () => {
    if (draft)
      saveAs(
        new Blob([encodeMarkdown(draft)], {
          type: "text/markdown;charset=utf-8",
        }),
        name,
      );
  };
  async function save() {
    if (!draft || !canEdit || current.current.busy) return false;
    if (!dirty) return true;
    const snapshot = { ...draft };
    setBusy(true);
    current.current.busy = true;
    try {
      const bytes = encodeMarkdown(snapshot);
      if (bytes.byteLength > MARKDOWN_LIMIT)
        throw new Error("文件超过 2 MB，请缩短内容后保存");
      const result = await uploadFile(
        new File([bytes], name, { type: "text/markdown;charset=utf-8" }),
        { spaceId: page.spaceId },
        () => {},
        { pageId: page.id, expectedVersion: snapshot.version },
      );
      if (identityKey.current !== key) return false;
      const savedVersion = (result as IPage & { fileVersion: number })
        .fileVersion;
      if (!Number.isInteger(savedVersion))
        throw new Error("保存状态未确认，请保留当前修改并重新加载");
      const saved = { ...snapshot, version: savedVersion };
      reset(saved);
      query.setQueryData(
        ["markdown-source", user?.workspaceId, user?.id, page.id, savedVersion],
        saved,
      );
      await onSaved().catch(() => undefined);
      notifications.show({ message: "Markdown 已保存" });
      return true;
    } catch (e) {
      notifications.show({ color: "red", message: errorMessage(e) });
      if (e?.response?.status === 409) await onSaved();
      return false;
    } finally {
      if (identityKey.current === key) {
        setBusy(false);
        current.current.busy = false;
      }
    }
  }
  saveRef.current = save;
  const reload = () =>
    modals.openConfirmModal({
      title: "重新加载服务器版本？",
      children: (
        <Text size="sm">当前未保存的修改将被放弃，可以先下载当前修改。</Text>
      ),
      labels: { confirm: "重新加载", cancel: "继续编辑" },
      onConfirm: async () => {
        setBusy(true);
        current.current.busy = true;
        try {
          const info = await officePost<any>("/office/info", {
            pageId: page.id,
          });
          const data = await readMarkdown(
            page.id,
            info.file.version,
            info.file.size,
          );
          if (identityKey.current !== key) return;
          reset(data);
          query.setQueryData(
            [
              "markdown-source",
              user?.workspaceId,
              user?.id,
              page.id,
              data.version,
            ],
            data,
          );
          await onSaved();
        } catch (e) {
          if (identityKey.current === key)
            notifications.show({ color: "red", message: errorMessage(e) });
        } finally {
          if (identityKey.current === key) {
            setBusy(false);
            current.current.busy = false;
          }
        }
      },
    });
  if (source.isError && !draft)
    return (
      <Alert color="red" m="lg">
        {errorMessage(source.error)}{" "}
        <Button variant="subtle" onClick={() => source.refetch()}>
          重试
        </Button>
      </Alert>
    );
  if (!draft || draftKey !== key)
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
        <Text size="sm">正在打开 Markdown</Text>
      </Group>
    );
  return (
    <section className={classes.root} aria-label="在线 Markdown">
      <Group className={classes.toolbar} justify="space-between" gap="xs">
        <Group gap="sm">
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(value) => setMode(String(value))}
            data={[
              { value: "read", label: "阅读" },
              { value: "source", label: "源码" },
              { value: "split", label: "双栏预览" },
            ]}
          />
          <Text size="xs" c={dirty ? "orange" : "dimmed"}>
            {dirty ? "未保存" : canEdit ? "已保存" : "只读"}
          </Text>
        </Group>
        {canEdit && (
          <Button
            size="xs"
            variant="light"
            leftSection={<IconDeviceFloppy size={15} />}
            loading={busy}
            disabled={!dirty}
            onClick={save}
          >
            保存
          </Button>
        )}
      </Group>
      {dirty && draft.version !== version && (
        <Alert color="orange" radius={0}>
          文件已有新版本，当前修改已保留。
          <Group mt="xs">
            <Button
              size="xs"
              variant="subtle"
              leftSection={<IconDownload size={14} />}
              onClick={downloadDraft}
            >
              下载当前修改
            </Button>
            <Button size="xs" variant="subtle" disabled={busy} onClick={reload}>
              重新加载
            </Button>
          </Group>
        </Alert>
      )}
      <div className={classes.body} data-mode={mode}>
        {mode !== "read" && (
          <div className={classes.source}>
            <Textarea
              aria-label="Markdown 源码"
              value={draft.text}
              spellCheck={false}
              readOnly={!canEdit || busy}
              onChange={(e) => {
                const value = { ...draft, text: e.currentTarget.value };
                setDraft(value);
                if (value.text !== value.savedText) remember(key, value);
                else drafts.delete(key);
              }}
            />
          </div>
        )}
        {mode !== "source" && (
          <article className={classes.preview} aria-label="Markdown 预览">
            <div
              className="ProseMirror"
              dangerouslySetInnerHTML={{
                __html:
                  html ||
                  '<p style="color:var(--mantine-color-dimmed)">暂无内容</p>',
              }}
            />
          </article>
        )}
      </div>
    </section>
  );
}
