import { OfficeTasks } from "./office-tasks";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconDownload,
  IconFileExport,
  IconHistory,
  IconInfoCircle,
  IconUpload,
} from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { officePost } from "./office-api";
import type { IPage } from "@/features/page/types/page.types";
import PageHeader from "@/features/page/components/header/page-header";
import { FileIcon } from "./file-icon";
import {
  downloadFile,
  downloadResult,
  errorMessage,
  modernExtension,
  uploadFile,
} from "./office-api";
import classes from "./office.module.css";
import { useUpdatePageMutation } from "@/features/page/queries/page-query";
import { useSetAtom } from "jotai";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { MarkdownFileEditor } from "./markdown-file-editor";
import { isMarkdown } from "./markdown-file-utils";
const scriptLoads = new Map<string, Promise<void>>();
function loadScript(url: string) {
  if (!scriptLoads.has(url)) {
    scriptLoads.set(
      url,
      new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => {
          scriptLoads.delete(url);
          script.remove();
          reject(new Error("编辑器加载失败，请重试"));
        };
        document.head.appendChild(script);
      }),
    );
  }
  return scriptLoads.get(url)!;
}
function OfficeEditor({
  pageId,
  version,
}: {
  pageId: string;
  version: number;
}) {
  const [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [attempt, setAttempt] = useState(0),
    host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false,
      editor: any;
    setError("");
    setReady(false);
    void (async () => {
      try {
        const data: any = await officePost("/office/editor", { pageId });
        await loadScript(data.scriptUrl);
        if (disposed || !host.current) return;
        const id = "office-" + crypto.randomUUID();
        const node = document.createElement("div");
        node.id = id;
        host.current.replaceChildren(node);
        editor = new (window as any).DocsAPI.DocEditor(id, {
          ...data.config,
          events: {
            onAppReady: () => setReady(true),
            onError: (e: any) =>
              setError(e?.data?.errorDescription || "编辑服务暂时不可用"),
          },
        });
      } catch (e) {
        if (!disposed) setError(errorMessage(e));
      }
    })();
    return () => {
      disposed = true;
      editor?.destroyEditor();
    };
  }, [pageId, version, attempt]);
  return (
    <div className={classes.editor}>
      {!ready && !error && (
        <Group className={classes.editorLoading}>
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            正在打开文件
          </Text>
        </Group>
      )}
      {error && (
        <Alert color="red" m="md">
          {error}
          <Button
            variant="subtle"
            size="xs"
            onClick={() => setAttempt((v) => v + 1)}
          >
            重试
          </Button>
        </Alert>
      )}
      <div
        ref={host}
        style={{ height: "100%", display: error ? "none" : undefined }}
      />
    </div>
  );
}
export function OfficeFilePage({
  page,
  canEdit,
}: {
  page: IPage;
  canEdit: boolean;
}) {
  const updatePage = useUpdatePageMutation(),
    setTree = useSetAtom(treeDataAtom);
  const query = useQuery({
      queryKey: ["office-info", page.id],
      refetchOnMount: "always",
      queryFn: () => officePost<any>("/office/info", { pageId: page.id }),
    }),
    q = useQueryClient(),
    input = useRef<HTMLInputElement>(null),
    [history, setHistory] = useState(false),
    [busy, setBusy] = useState(false),
    [taskId, setTaskId] = useState<string | null>(null),
    [name, setName] = useState(page.title),
    navigate = useNavigate();
  const task = useQuery({
    queryKey: ["office-task", taskId],
    queryFn: () => officePost<any>("/office/task", { taskId }),
    enabled: !!taskId,
    refetchInterval: (query) =>
      ["succeeded", "failed"].includes(query.state.data?.state) ? false : 1500,
  });
  useEffect(() => {
    setName(page.title);
    setTaskId(null);
  }, [page.id, page.title]);
  useEffect(() => {
    if (!task.data || !taskId) return;
    if (task.data.state === "failed") {
      notifications.show({ color: "red", message: task.data.error });
      setTaskId(null);
    } else if (task.data.state === "succeeded") {
      if (task.data.result) {
        q.invalidateQueries({ queryKey: ["sidebar-pages"] });
        q.invalidateQueries({ queryKey: ["office-directory"] });
        const p = task.data.result;
        navigate(`/s/${page.space.slug}/p/${p.slugId}`);
      } else
        void downloadResult(
          taskId,
          page.title.replace(/\.[^.]+$/, "") + ".pdf",
        ).catch((e) =>
          notifications.show({ color: "red", message: errorMessage(e) }),
        );
      setTaskId(null);
    }
  }, [task.data, taskId]);
  async function convert(purpose: string) {
    setBusy(true);
    try {
      const result: any = await officePost("/office/convert", {
        pageId: page.id,
        format:
          purpose === "export" ? "pdf" : modernExtension(page.fileExtension),
        purpose,
      });
      setTaskId(result.id);
    } catch (e) {
      notifications.show({ color: "red", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  async function replace(file: File) {
    setBusy(true);
    try {
      await uploadFile(file, { spaceId: page.spaceId }, () => {}, {
        pageId: page.id,
        expectedVersion: query.data.file.version,
      });
      await q.invalidateQueries({ queryKey: ["office-info", page.id] });
    } catch (e) {
      notifications.show({ color: "red", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  const file = query.data?.file,
    officeEnabled = query.data?.officeEnabled,
    downloadName =
      page.fileExtension &&
      !page.title.toLowerCase().endsWith("." + page.fileExtension)
        ? page.title + "." + page.fileExtension
        : page.title;
  return (
    <div className={classes.fileRoot}>
      <PageHeader readOnly={!canEdit} />
      <Group justify="space-between" className={classes.fileHeader} gap="sm">
        <Group wrap="nowrap" style={{ flex: 1, minWidth: 150 }}>
          <FileIcon type={page.nodeType} ext={page.fileExtension} size={20} />
          <TextInput
            variant="unstyled"
            aria-label="文件名称"
            value={name}
            readOnly={!canEdit}
            style={{ flex: 1 }}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={() => {
              if (name.trim() && name !== page.title)
                void updatePage
                  .mutateAsync({
                    pageId: page.id,
                    title: name.trim(),
                  })
                  .then((updated) =>
                    setTree((rows) =>
                      treeModel.update(rows, page.id, { name: updated.title }),
                    ),
                  )
                  .catch((e) =>
                    notifications.show({
                      color: "red",
                      message: errorMessage(e),
                    }),
                  );
            }}
          />
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            v{file?.version || 1}
          </Text>
        </Group>
        <Group gap={6}>
          <OfficeTasks />
          {officeEnabled &&
            !isMarkdown(page.fileExtension) &&
            (modernExtension(page.fileExtension) ||
              page.fileExtension === "pdf") && (
              <Tooltip label="关于编辑器">
                <ActionIcon
                  component="a"
                  href={query.data.editorLegalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="subtle"
                  aria-label="关于编辑器"
                >
                  <IconInfoCircle size={17} />
                </ActionIcon>
              </Tooltip>
            )}
          <Tooltip label="下载文件">
            <ActionIcon
              variant="default"
              aria-label="下载文件"
              disabled={!file}
              onClick={() =>
                void downloadFile(page.id, downloadName).catch((e) =>
                  notifications.show({
                    color: "red",
                    message: errorMessage(e),
                  }),
                )
              }
            >
              <IconDownload size={17} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="历史版本">
            <ActionIcon
              variant="default"
              aria-label="历史版本"
              onClick={() => setHistory(true)}
            >
              <IconHistory size={17} />
            </ActionIcon>
          </Tooltip>
          {canEdit && (
            <Tooltip label="上传替换版本">
              <ActionIcon
                variant="default"
                aria-label="上传替换版本"
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                <IconUpload size={17} />
              </ActionIcon>
            </Tooltip>
          )}
          {officeEnabled && modernExtension(page.fileExtension) && (
            <Button
              size="xs"
              variant="default"
              leftSection={<IconFileExport size={15} />}
              loading={busy || !!taskId}
              onClick={() => convert("export")}
            >
              导出 PDF
            </Button>
          )}
          {officeEnabled &&
            canEdit &&
            page.nodeType === "file" &&
            modernExtension(page.fileExtension) && (
              <Button
                size="xs"
                variant="light"
                disabled={busy || !!taskId}
                onClick={() => convert("online-copy")}
              >
                创建在线副本
              </Button>
            )}
        </Group>
      </Group>
      <input
        type="file"
        hidden
        ref={input}
        accept={"." + page.fileExtension}
        onChange={(e) => {
          if (e.target.files?.[0]) void replace(e.target.files[0]);
          e.target.value = "";
        }}
      />
      {query.isLoading ? (
        <Loader m="lg" />
      ) : query.isError ? (
        <Alert color="red" m="lg">
          文件加载失败{" "}
          <Button size="xs" variant="subtle" onClick={() => query.refetch()}>
            重试
          </Button>
        </Alert>
      ) : isMarkdown(page.fileExtension) && file ? (
        <MarkdownFileEditor
          page={page}
          version={file.version}
          size={file.size}
          canEdit={canEdit && query.data.canEdit}
          name={downloadName}
          onSaved={() =>
            q.invalidateQueries({ queryKey: ["office-info", page.id] })
          }
        />
      ) : officeEnabled &&
        (modernExtension(page.fileExtension) ||
          page.fileExtension === "pdf") ? (
        <OfficeEditor pageId={page.id} version={file?.version || 1} />
      ) : (
        <Stack className={classes.preview} align="center" gap="md">
          <FileIcon type="file" ext={page.fileExtension} size={60} />
          <Text fw={600}>{page.title}</Text>
          <Text size="sm" c="dimmed">
            {file ? (file.size / 1024).toFixed(1) + " KB" : "暂无文件内容"}
          </Text>
          {["png", "jpg", "jpeg", "webp"].includes(page.fileExtension || "") ? (
            <img
              src={`/api/office/download/${page.id}?inline=1`}
              alt={page.title}
              style={{
                maxWidth: "100%",
                maxHeight: "65vh",
                objectFit: "contain",
              }}
            />
          ) : null}
          <Button
            leftSection={<IconDownload size={16} />}
            onClick={() => void downloadFile(page.id, downloadName)}
          >
            下载文件
          </Button>
        </Stack>
      )}
      <Modal
        opened={history}
        onClose={() => setHistory(false)}
        title="历史版本"
        radius="lg"
        centered
      >
        <Stack>
          {query.data?.versions.map((v: any) => (
            <Group key={v.id} justify="space-between">
              <div>
                <Text size="sm" fw={500}>
                  版本 {v.version}
                </Text>
                <Text size="xs" c="dimmed">
                  {new Date(v.createdAt).toLocaleString("zh-CN")}
                </Text>
              </div>
              <Group gap="xs">
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() =>
                    void downloadFile(page.id, v.fileName, v.version)
                  }
                >
                  下载
                </Button>
                {canEdit && v.version !== file?.version && (
                  <Button
                    variant="light"
                    size="xs"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await officePost("/office/restore", {
                          pageId: page.id,
                          version: v.version,
                          expectedVersion: file.version,
                        });
                        await query.refetch();
                        notifications.show({ message: "已恢复为新的版本" });
                      } catch (e) {
                        notifications.show({
                          color: "red",
                          message: errorMessage(e),
                        });
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    恢复
                  </Button>
                )}
              </Group>
            </Group>
          ))}
        </Stack>
      </Modal>
    </div>
  );
}
