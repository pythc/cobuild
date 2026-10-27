import { FileIcon } from "@/features/office/file-icon";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useNavigate, useParams } from "react-router-dom";
import {
  Modal,
  Button,
  Group,
  Stack,
  Text,
  TextInput,
  Textarea,
  SimpleGrid,
  UnstyledButton,
  Alert,
  Loader,
  Badge,
  ScrollArea,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  IconTemplate,
  IconPlus,
  IconSearch,
  IconArrowLeft,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
import DOMPurify from "dompurify";
import api from "@/lib/api-client";
import { Directory, errorMessage } from "@/features/office/office-api";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { buildTree } from "@/features/page/tree/utils/utils";
import { buildPageUrl } from "@/features/page/page.utils";
import classes from "./templates.module.css";
import { useQueryEmit } from "@/features/websocket/use-query-emit";
function DirectoryPreview({
  nodes,
  onSelect,
}: {
  nodes: any[];
  onSelect: (node: any) => void;
}) {
  return (
    <Stack gap={4}>
      {nodes.map((node, i) => (
        <div key={node.title + ":" + i}>
          {node.kind === "directory" ? (
            <details open>
              <summary
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px",
                  cursor: "pointer",
                }}
              >
                <FileIcon type="folder" size={18} />
                <Text size="sm" fw={500}>
                  {node.title}
                </Text>
              </summary>
              <div style={{ paddingLeft: 24 }}>
                <DirectoryPreview
                  nodes={node.children || []}
                  onSelect={onSelect}
                />
              </div>
            </details>
          ) : (
            <UnstyledButton
              onClick={() => onSelect(node)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: 8,
                width: "100%",
                borderRadius: 6,
              }}
            >
              <FileIcon type="page" size={18} />
              <Text size="sm">{node.title}</Text>
            </UnstyledButton>
          )}
        </div>
      ))}
    </Stack>
  );
}
export function TemplatePicker({
  opened,
  onClose,
  target,
  onCreated,
  beforeCreate,
}: {
  opened: boolean;
  onClose: () => void;
  target: Directory;
  onCreated?: () => void;
  beforeCreate?: () => Promise<void> | void;
}) {
  const emit = useQueryEmit();
  const store = useStore();
  const [search, setSearch] = useState(""),
    [category, setCategory] = useState("全部"),
    [selected, setSelected] = useState<string | null>(null),
    [form, setForm] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [title, setTitle] = useState("");
  const [child, setChild] = useState<any>(null);
  useEffect(() => setChild(null), [selected]);
  const user = useAtomValue(userAtom);
  useEffect(() => {
    if (!opened) {
      setSelected(null);
      setForm(null);
    }
  }, [opened]);
  const tree = useSetAtom(treeDataAtom),
    query = useQueryClient(),
    navigate = useNavigate(),
    { spaceSlug } = useParams();
  const list = useQuery({
    queryKey: ["knowledge-templates", user?.workspaceId, user?.id],
    queryFn: async () => (await api.post("/knowledge-templates/list")).data,
    enabled: opened,
  });
  const preview = useQuery({
    queryKey: ["knowledge-template", user?.workspaceId, user?.id, selected],
    queryFn: async () =>
      (await api.post("/knowledge-templates/info", { id: selected })).data,
    enabled: opened && !!selected,
  });
  const items = list.data?.items || [],
    categories = [
      "全部",
      ...new Set<string>(items.map((x: any) => x.category)),
    ];
  const filtered = items.filter(
    (x: any) =>
      (category === "全部" || x.category === category) &&
      (x.title + " " + (x.description || ""))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const close = () => {
    if (busy) return;
    if (form) {
      modals.openConfirmModal({
        title: "放弃模板修改？",
        children: <Text size="sm">未保存的内容将被放弃。</Text>,
        labels: { confirm: "放弃修改", cancel: "继续编辑" },
        onConfirm: () => {
          setForm(null);
          onClose();
        },
      });
      return;
    }
    onClose();
  };
  async function useTemplate() {
    if (busy) return;
    setBusy(true);
    try {
      await beforeCreate?.();
      const page = (
        await api.post("/knowledge-templates/apply", {
          ...target,
          parentPageId: target.parentPageId || undefined,
          id: selected,
          title: title.trim() || undefined,
        })
      ).data;
      const current = store.get(treeDataAtom);
      const parentId = page.parentPageId || null;
      const node = buildTree([page])[0];
      const index = parentId
        ? treeModel.find(current, parentId)?.children?.length || 0
        : current.length;
      tree((rows) => treeModel.insert(rows, parentId, node, index));
      emit({
        operation: "addTreeNode",
        spaceId: target.spaceId,
        payload: { parentId, index, data: node },
      });
      await Promise.all([
        query.invalidateQueries({ queryKey: ["office-directory"] }),
        query.invalidateQueries({ queryKey: ["root-sidebar-pages"] }),
        query.invalidateQueries({ queryKey: ["sidebar-pages"] }),
        query.invalidateQueries({ queryKey: ["pages"] }),
      ]);
      onCreated?.();
      onClose();
      navigate(buildPageUrl(spaceSlug, page.slugId, page.title));
    } catch (e) {
      notifications.show({ color: "red", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const saved = (await api.post("/knowledge-templates/save", form)).data;
      await query.invalidateQueries({ queryKey: ["knowledge-templates"] });
      await query.invalidateQueries({
        queryKey: ["knowledge-template", user?.workspaceId, user?.id, saved.id],
      });
      setForm(null);
      setSelected(saved.id);
      setTitle(saved.title);
      setCategory("我的模板");
      notifications.show({ message: "模板已保存" });
    } catch (e) {
      notifications.show({ color: "red", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  function remove() {
    const x = preview.data;
    if (!x) return;
    modals.openConfirmModal({
      title: "删除模板？",
      children: (
        <Text size="sm">删除“{x.title}”不会影响已使用它创建的文档。</Text>
      ),
      labels: { confirm: "删除", cancel: "取消" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await api.post("/knowledge-templates/delete", {
            id: x.id,
            expectedUpdatedAt: x.updatedAt,
          });
          setSelected(null);
          await query.invalidateQueries({ queryKey: ["knowledge-templates"] });
        } catch (e) {
          notifications.show({ color: "red", message: errorMessage(e) });
        }
      },
    });
  }
  return (
    <Modal
      opened={opened}
      onClose={close}
      title="按模板新建"
      size="min(1080px, 96vw)"
      centered
      radius="lg"
      onClick={(e) => e.stopPropagation()}
    >
      {form ? (
        <Stack>
          <Group>
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconArrowLeft size={16} />}
              onClick={() => {
                modals.openConfirmModal({
                  title: "放弃模板修改？",
                  labels: { confirm: "放弃修改", cancel: "继续编辑" },
                  onConfirm: () => setForm(null),
                });
              }}
            >
              返回模板库
            </Button>
          </Group>
          <TextInput
            label="模板名称"
            disabled={busy}
            value={form.title}
            maxLength={180}
            onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
          />
          <TextInput
            label="简介"
            disabled={busy}
            value={form.description}
            maxLength={500}
            onChange={(e) =>
              setForm({ ...form, description: e.currentTarget.value })
            }
          />
          <Textarea
            label="模板内容"
            disabled={busy}
            description="支持 Markdown：标题、列表、表格、链接和代码块"
            value={form.content}
            onChange={(e) =>
              setForm({ ...form, content: e.currentTarget.value })
            }
            minRows={14}
            maxRows={24}
            autosize
          />
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              保存到我的模板，仅自己可见
            </Text>
            <Button
              loading={busy}
              disabled={!form.title.trim() || !form.content.trim()}
              onClick={save}
            >
              保存模板
            </Button>
          </Group>
        </Stack>
      ) : (
        <>
          <Group justify="space-between" mb="md">
            <TextInput
              placeholder="搜索模板"
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              style={{ flex: 1, maxWidth: 360 }}
            />
            <Button
              variant="light"
              leftSection={<IconPlus size={16} />}
              onClick={() =>
                setForm({
                  title: "",
                  description: "",
                  content: "",
                  format: "markdown",
                })
              }
            >
              创建模板
            </Button>
          </Group>
          <div
            className={classes.layout}
            style={{ display: selected ? "none" : undefined }}
          >
            <div className={classes.categories}>
              {categories.map((x) => (
                <UnstyledButton
                  key={x}
                  className={classes.category}
                  data-active={category === x || undefined}
                  onClick={() => setCategory(x)}
                >
                  {x}
                </UnstyledButton>
              ))}
            </div>
            <ScrollArea h={520} className={classes.gallery}>
              {list.isPending ? (
                <Loader />
              ) : list.isError ? (
                <Alert color="red">
                  模板加载失败
                  <Button variant="subtle" onClick={() => list.refetch()}>
                    重试
                  </Button>
                </Alert>
              ) : (
                <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
                  {filtered.map((x: any) => (
                    <UnstyledButton
                      key={x.id}
                      className={classes.card}
                      data-active={selected === x.id || undefined}
                      onClick={() => {
                        setSelected(x.id);
                        setTitle(x.title);
                      }}
                    >
                      <div className={classes.cover} data-category={x.category}>
                        <IconTemplate size={36} stroke={1.2} />
                        <Badge size="xs" variant="white">
                          {x.childCount ? "文档集" : "文档"}
                        </Badge>
                      </div>
                      <div className={classes.meta}>
                        <Text fw={600} size="sm">
                          {x.title}
                        </Text>
                        <Text size="xs" c="dimmed" lineClamp={2} mt={6}>
                          {x.description || x.category}
                        </Text>
                      </div>
                    </UnstyledButton>
                  ))}
                </SimpleGrid>
              )}
              {!list.isPending && !filtered.length && (
                <Text c="dimmed" size="sm" py="xl">
                  没有匹配的模板
                </Text>
              )}
            </ScrollArea>
          </div>
          {selected && (
            <div className={classes.preview}>
              <Group justify="space-between" mb="sm">
                <Button
                  variant="subtle"
                  size="xs"
                  leftSection={<IconArrowLeft size={16} />}
                  onClick={() => setSelected(null)}
                >
                  返回模板库
                </Button>
                {preview.data?.builtin && preview.data.kind !== "directory" && (
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() =>
                      setForm({
                        title: preview.data.title,
                        description: preview.data.description || "",
                        content: preview.data.markdown || "",
                        format: "markdown",
                      })
                    }
                  >
                    另存为我的模板
                  </Button>
                )}
                {preview.data?.canEdit && (
                  <Group gap="xs">
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={<IconPencil size={14} />}
                      onClick={() =>
                        setForm({
                          id: preview.data.id,
                          expectedUpdatedAt: preview.data.updatedAt,
                          title: preview.data.title,
                          description: preview.data.description || "",
                          content: preview.data.markdown || "",
                          format: "markdown",
                        })
                      }
                    >
                      编辑
                    </Button>
                    <Button
                      size="xs"
                      color="red"
                      variant="subtle"
                      leftSection={<IconTrash size={14} />}
                      onClick={remove}
                    >
                      删除
                    </Button>
                  </Group>
                )}
              </Group>
              {preview.isPending ? (
                <Loader size="sm" />
              ) : preview.isError ? (
                <Alert color="red">
                  预览加载失败
                  <Button variant="subtle" onClick={() => preview.refetch()}>
                    重试
                  </Button>
                </Alert>
              ) : (
                <>
                  <Text fw={600} size="lg" mb="sm">
                    {child?.title || preview.data?.title}
                  </Text>
                  {child && (
                    <Button
                      variant="subtle"
                      size="xs"
                      onClick={() => setChild(null)}
                    >
                      返回文档集
                    </Button>
                  )}
                  <ScrollArea h={420}>
                    {preview.data?.kind === "directory" && !child ? (
                      <DirectoryPreview
                        nodes={preview.data.children || []}
                        onSelect={setChild}
                      />
                    ) : (
                      <div
                        className="ProseMirror"
                        dangerouslySetInnerHTML={{
                          __html: DOMPurify.sanitize(
                            child?.html || preview.data?.html || "",
                          ),
                        }}
                      />
                    )}
                    {preview.data?.children?.length > 0 && (
                      <Text size="xs" c="dimmed">
                        包含 {preview.data.children.length} 个子文档／目录
                      </Text>
                    )}
                  </ScrollArea>
                </>
              )}
              <Group justify="space-between" mt="md">
                <TextInput
                  aria-label="新页面名称"
                  maxLength={180}
                  disabled={busy}
                  value={title}
                  onChange={(e) => setTitle(e.currentTarget.value)}
                  style={{ flex: 1 }}
                />
                <Button
                  loading={busy}
                  disabled={!preview.data || preview.isError || !title.trim()}
                  onClick={useTemplate}
                >
                  使用模板
                </Button>
              </Group>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
