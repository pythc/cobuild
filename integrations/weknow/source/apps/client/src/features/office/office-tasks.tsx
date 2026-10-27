import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Group,
  Modal,
  Stack,
  Text,
  Badge,
  ActionIcon,
} from "@mantine/core";
import { IconHistory, IconDownload } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { officePost } from "./office-api";
import { downloadResult, errorMessage } from "./office-api";
export function OfficeTasks() {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["office-tasks"],
    queryFn: () => officePost<any>("/office/tasks", {}),
    enabled: open,
    refetchInterval: open ? 3000 : false,
  });
  return (
    <>
      <Button
        size="xs"
        variant="subtle"
        color="gray"
        leftSection={<IconHistory size={15} />}
        onClick={() => setOpen(true)}
      >
        转换记录
      </Button>
      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        title="转换记录"
        centered
        radius="lg"
      >
        <Stack>
          {query.data?.items.length ? (
            query.data.items.map((task: any) => (
              <Group key={task.id} justify="space-between" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Text fw={500} size="sm" truncate>
                    {task.title}
                  </Text>
                  <Text
                    c={task.state === "failed" ? "red" : "dimmed"}
                    size="xs"
                  >
                    {task.error ||
                      new Date(task.createdAt).toLocaleString("zh-CN")}
                  </Text>
                </div>
                <Group gap="xs" wrap="nowrap">
                  <Badge
                    variant="light"
                    color={
                      task.state === "failed"
                        ? "red"
                        : task.state === "succeeded"
                          ? "teal"
                          : "blue"
                    }
                  >
                    {
                      (
                        {
                          queued: "等待中",
                          running: "转换中",
                          succeeded: "已完成",
                          failed: "失败",
                        } as any
                      )[task.state]
                    }
                  </Badge>
                  {task.state === "succeeded" &&
                    (task.resultPage ? (
                      <Button
                        component={Link}
                        to={task.resultUrl}
                        size="xs"
                        variant="subtle"
                      >
                        打开
                      </Button>
                    ) : (
                      <ActionIcon
                        variant="subtle"
                        aria-label={"下载 " + task.title}
                        onClick={() =>
                          void downloadResult(task.id, task.fileName).catch(
                            (e) =>
                              notifications.show({
                                color: "red",
                                message: errorMessage(e),
                              }),
                          )
                        }
                      >
                        <IconDownload size={16} />
                      </ActionIcon>
                    ))}
                </Group>
              </Group>
            ))
          ) : (
            <Text c="dimmed" size="sm">
              {query.isLoading
                ? "正在加载"
                : query.isError
                  ? "记录加载失败"
                  : "暂无转换记录"}
            </Text>
          )}
        </Stack>
      </Modal>
    </>
  );
}
