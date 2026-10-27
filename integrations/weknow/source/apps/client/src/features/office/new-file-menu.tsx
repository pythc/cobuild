import { useSetAtom, useStore } from "jotai";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { buildTree } from "@/features/page/tree/utils/utils";
import { useRef, useState, ReactElement } from "react";
import {
  Button,
  Group,
  Menu,
  Modal,
  TextInput,
  SegmentedControl,
  Stack,
} from "@mantine/core";
import {
  IconPlus,
  IconUpload,
  IconChevronDown,
  IconTemplate,
} from "@tabler/icons-react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { officePost, Directory, errorMessage } from "./office-api";
import { buildPageUrl } from "@/features/page/page.utils";
import { createPage } from "@/features/page/services/page-service";
import { FileIcon } from "./file-icon";
import { useFileUploads } from "./file-upload";
import { TemplatePicker } from "@/features/document-template/template-picker";
import { useQueryEmit } from "@/features/websocket/use-query-emit";
export function NewFileMenu({
  target,
  onUpload,
  onCreated,
  officeEnabled = true,
  trigger,
  beforeCreate,
}: {
  target: Directory;
  onUpload?: () => void;
  onCreated?: () => void;
  officeEnabled?: boolean;
  trigger?: ReactElement;
  beforeCreate?: () => Promise<void> | void;
}) {
  const emit = useQueryEmit();
  const store = useStore();
  const [type, setType] = useState<string | null>(null),
    [name, setName] = useState(""),
    [mode, setMode] = useState("office"),
    [busy, setBusy] = useState(false),
    [templates, setTemplates] = useState(false);
  const tree = useSetAtom(treeDataAtom),
    query = useQueryClient(),
    navigate = useNavigate(),
    { spaceSlug } = useParams(),
    input = useRef<HTMLInputElement>(null),
    { enqueue } = useFileUploads();
  const choices = [
    ["page", "文档"],
    ["md", "Markdown 文件"],
    ["docx", "Word 文档"],
    ["xlsx", "Excel 表格"],
    ["pptx", "PPT 演示文稿"],
    ["folder", "文件夹"],
  ];
  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      await beforeCreate?.();
      const page =
        type === "page"
          ? await createPage({
              spaceId: target.spaceId,
              parentPageId: target.parentPageId || undefined,
              title: name.trim(),
            })
          : await officePost("/office/create", {
              ...target,
              title: name.trim(),
              type,
              mode,
            });
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
      setType(null);
      onCreated?.();
      navigate(buildPageUrl(spaceSlug, page.slugId, page.title));
    } catch (e) {
      notifications.show({ color: "red", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span
        style={{ display: "contents" }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <Menu position="bottom-start" shadow="sm" radius="md" width={220}>
          <Menu.Target>
            {trigger || (
              <Button
                size="sm"
                leftSection={<IconPlus size={16} />}
                rightSection={<IconChevronDown size={13} />}
                variant="light"
              >
                新建
              </Button>
            )}
          </Menu.Target>
          <Menu.Dropdown>
            {choices.map(([value, label]) => (
              <Menu.Item
                key={value}
                leftSection={
                  <FileIcon
                    type={
                      value === "folder"
                        ? "folder"
                        : value === "page"
                          ? "page"
                          : "file"
                    }
                    ext={value}
                    size={18}
                  />
                }
                onClick={() => {
                  setType(value);
                  setName(
                    value === "page"
                      ? "未命名"
                      : value === "folder"
                        ? "新建文件夹"
                        : label,
                  );
                  setMode(officeEnabled ? "office" : "file");
                }}
              >
                {label}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Item
              leftSection={<IconTemplate size={18} />}
              onClick={() => setTemplates(true)}
            >
              按模板新建
            </Menu.Item>
            <Menu.Item
              leftSection={<IconUpload size={18} />}
              onClick={() => (onUpload ? onUpload() : input.current?.click())}
            >
              上传文件
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </span>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          void enqueue(Array.from(e.target.files || []), target);
          e.target.value = "";
        }}
      />
      <Modal
        opened={!!type}
        onClose={() => !busy && setType(null)}
        title={"新建" + (choices.find((v) => v[0] === type)?.[1] || "")}
        centered
        radius="lg"
        onClick={(e) => e.stopPropagation()}
      >
        <Stack>
          <TextInput
            label="名称"
            value={name}
            autoFocus
            maxLength={180}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !busy) void create();
            }}
          />
          {type && type !== "folder" && type !== "page" && type !== "md" && (
            <SegmentedControl
              value={mode}
              onChange={(value) => setMode(String(value))}
              data={[
                {
                  label: "在线版本",
                  value: "office",
                  disabled: !officeEnabled,
                },
                { label: "普通文件", value: "file" },
              ]}
            />
          )}
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => setType(null)}
              disabled={busy}
            >
              取消
            </Button>
            <Button onClick={create} loading={busy} disabled={!name.trim()}>
              创建
            </Button>
          </Group>
        </Stack>
      </Modal>
      <TemplatePicker
        opened={templates}
        onClose={() => setTemplates(false)}
        target={target}
        onCreated={onCreated}
        beforeCreate={beforeCreate}
      />
    </>
  );
}
