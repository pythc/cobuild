import { OfficeTasks } from "./office-tasks";
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import {
  IconChevronRight,
  IconFolder,
  IconRefresh,
  IconUpload,
} from "@tabler/icons-react";
import { Link, useParams } from "react-router-dom";
import { buildPageUrl } from "@/features/page/page.utils";
import { useFileUploads } from "./file-upload";
import { NewFileMenu } from "./new-file-menu";
import { FileIcon } from "./file-icon";
import { Directory, listDirectory } from "./office-api";
import classes from "./office.module.css";
export function OfficeDirectory({
  target,
  canEdit,
  title = "目录",
}: {
  target: Directory;
  canEdit: boolean;
  title?: string;
}) {
  const query = useQuery({
      queryKey: ["office-directory", target.spaceId, target.parentPageId],
      queryFn: () => listDirectory(target),
    }),
    input = useRef<HTMLInputElement>(null),
    { enqueue } = useFileUploads(),
    { spaceSlug } = useParams();
  return (
    <section className={classes.directory}>
      <Group justify="space-between" mb="lg">
        <Group gap="sm">
          <IconFolder size={22} stroke={1.6} />
          <Text fw={600} size="lg">
            {title}
          </Text>
        </Group>
        <Group gap="xs">
          <OfficeTasks />
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="刷新目录"
            onClick={() => query.refetch()}
          >
            <IconRefresh size={17} />
          </ActionIcon>
          {canEdit && (
            <NewFileMenu
              target={target}
              onUpload={() => input.current?.click()}
              officeEnabled={query.data?.officeEnabled}
            />
          )}
        </Group>
      </Group>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void enqueue(Array.from(e.target.files || []), target);
          e.target.value = "";
        }}
      />
      {query.isLoading ? (
        <Loader size="sm" />
      ) : query.isError ? (
        <Alert color="red">
          目录加载失败{" "}
          <Button variant="subtle" size="xs" onClick={() => query.refetch()}>
            重试
          </Button>
        </Alert>
      ) : query.data?.items.length ? (
        <div className={classes.list}>
          {query.data.items.map((page) => (
            <Link
              key={page.id}
              to={buildPageUrl(spaceSlug, page.slugId, page.title)}
              className={classes.row}
              data-directory-id={
                page.nodeType === "folder" || page.nodeType === "page"
                  ? page.id
                  : undefined
              }
            >
              <span className={classes.icon}>
                <FileIcon
                  type={page.nodeType}
                  ext={page.fileExtension}
                  size={27}
                />
              </span>
              <div className={classes.name}>
                <Text size="sm" fw={500} truncate>
                  {page.title || "无标题"}
                </Text>
                <Text size="xs" c="dimmed">
                  {page.nodeType === "folder"
                    ? "文件夹"
                    : page.nodeType === "office"
                      ? "在线 · " + page.fileExtension?.toUpperCase()
                      : page.nodeType === "file"
                        ? page.fileExtension?.toUpperCase() + " 文件"
                        : "知识库文档"}
                </Text>
              </div>
              <Text size="xs" c="dimmed" className={classes.date}>
                {new Date(page.updatedAt).toLocaleDateString("zh-CN")}
              </Text>
              <IconChevronRight size={16} color="var(--mantine-color-dimmed)" />
            </Link>
          ))}
        </div>
      ) : (
        <Paper className={classes.empty} radius="lg" withBorder>
          <Stack align="center" gap="sm">
            <IconFolder
              size={36}
              stroke={1.2}
              color="var(--mantine-color-dimmed)"
            />
            <Text size="sm" c="dimmed">
              此目录还没有内容
            </Text>
            {canEdit && (
              <Button
                variant="light"
                size="sm"
                leftSection={<IconUpload size={16} />}
                onClick={() => input.current?.click()}
              >
                上传文件
              </Button>
            )}
          </Stack>
        </Paper>
      )}
    </section>
  );
}
