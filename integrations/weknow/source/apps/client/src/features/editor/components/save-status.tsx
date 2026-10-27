import { Button, Group, Popover, Text, UnstyledButton } from "@mantine/core";
import {
  IconCloudCheck,
  IconCloudUpload,
  IconWifiOff,
  IconAlertCircle,
} from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { saveLabel, saveStateAtom } from "../save-state";
import { pageEditorAtom } from "../atoms/editor-atoms";
export function SaveStatus({ pageId }: { pageId: string }) {
  const state = useAtomValue(saveStateAtom),
    editor = useAtomValue(pageEditorAtom);
  if (state.pageId !== pageId) return null;
  const Icon =
    state.phase === "saved"
      ? IconCloudCheck
      : state.phase === "offline"
        ? IconWifiOff
        : ["auth", "permission", "error"].includes(state.phase)
          ? IconAlertCircle
          : IconCloudUpload;
  return (
    <Popover position="bottom-end" width={280} withArrow shadow="sm">
      <Popover.Target>
        <UnstyledButton
          aria-label={saveLabel(state)}
          style={{ borderRadius: 6, padding: "6px 8px", flexShrink: 0 }}
        >
          <Group gap={6} wrap="nowrap">
            <Icon
              size={16}
              color={state.phase === "saved" ? "#43866c" : undefined}
            />
            <Text size="xs" visibleFrom="md" role="status" aria-live="polite">
              {saveLabel(state)}
            </Text>
          </Group>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown>
        <Text size="sm" fw={500}>
          {saveLabel(state)}
        </Text>
        <Text size="xs" c="dimmed" mt={6}>
          {state.phase === "saved"
            ? "服务器已确认保存当前修改。"
            : "请保留当前页面。本机副本仅存于这个浏览器，清理浏览器数据会删除它。"}
        </Text>
        {state.phase === "auth" && (
          <Button
            component="a"
            href="/login"
            target="_blank"
            rel="noopener"
            size="xs"
            mt="sm"
          >
            重新登录
          </Button>
        )}
        {state.phase === "auth" && (
          <Button
            size="xs"
            variant="subtle"
            mt="sm"
            onClick={() => window.dispatchEvent(new Event("weknow:retry-auth"))}
          >
            已登录，恢复同步
          </Button>
        )}
        {state.phase !== "saved" && editor && (
          <Button
            variant="subtle"
            size="xs"
            mt="xs"
            onClick={() => {
              const blob = new Blob(
                  [JSON.stringify(editor.getJSON(), null, 2)],
                  { type: "application/json" },
                ),
                url = URL.createObjectURL(blob),
                a = document.createElement("a");
              a.href = url;
              a.download = "weknow-local-backup.json";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            下载当前内容副本
          </Button>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
