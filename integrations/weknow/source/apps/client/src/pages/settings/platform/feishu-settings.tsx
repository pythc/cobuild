import React, { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Pagination,
  Accordion,
} from "@mantine/core";
import {
  IconRefresh,
  IconUsers,
  IconBrandHipchat,
  IconSearch,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CustomAvatar } from "@/components/ui/custom-avatar";

interface Member {
  id: string;
  name: string;
  avatarUrl: string;
  role: string;
  deactivatedAt: string | null;
  directoryStatus: string;
  directoryCheckedAt: string | null;
}
interface Run {
  id: number;
  source: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  added: number;
  updated: number;
  blocked: number;
  errorCode: string | null;
}
interface Status {
  enabled: boolean;
  intervalSeconds: number;
  maxAgeSeconds: number;
  events: string;
  members: Member[];
  runs: Run[];
  notifications: {
    enabled: boolean;
    counts: { state: string; count: number }[];
  };
}
const names: Record<string, string> = {
  active: "正常",
  frozen: "飞书停用",
  resigned: "已离职",
  exited: "已退出",
  unactivated: "未激活",
  out_of_scope: "无应用权限",
  unknown: "待同步",
};
const sources: Record<string, string> = {
  startup: "启动同步",
  scheduled: "定时同步",
  manual: "手动同步",
  event: "飞书事件",
  login: "登录检查",
};
const errors: Record<string, string> = {
  invalid_contact_scope: "无法读取完整通讯录范围",
  invalid_visibility: "无法读取完整应用范围",
  sync_failed: "未取得完整成员数据，请检查字段权限",
  network_error: "飞书连接暂时不可用",
  sync_unavailable: "同步暂时不可用",
};
async function api<T>(path: string, method = "GET"): Promise<T> {
  const r = await fetch("/api/integrations/feishu/" + path, {
    method,
    credentials: "same-origin",
  });
  if (!r.ok) throw new Error("无法读取飞书集成，请确认管理员权限后重试");
  const result = await r.json();
  return result.data ?? result;
}
function time(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "—";
}

export default function FeishuSettings() {
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [syncError, setSyncError] = useState("");
  const [testResult, setTestResult] = useState<{
    success: boolean;
    text: string;
  } | null>(null);
  const testNotification = useMutation({
    mutationFn: () => api<{ sent: boolean }>("test-notification", "POST"),
    onSuccess: () =>
      setTestResult({ success: true, text: "测试通知已发送到你的飞书。" }),
    onError: () =>
      setTestResult({
        success: false,
        text: "发送结果未确认，请先在飞书检查后再试。",
      }),
  });
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["feishu-integration"],
    queryFn: () => api<Status>("status"),
    refetchInterval: 15000,
  });
  const sync = useMutation({
    mutationFn: () =>
      api<{ status: string; errorCode?: string }>("sync", "POST"),
    onMutate: () => setSyncError(""),
    onSuccess: (r) => {
      if (r.status === "failed")
        setSyncError(errors[r.errorCode] || "同步未完成，请检查飞书权限与连接");
      if (r.status === "busy") setSyncError("已有同步正在执行，请稍后查看结果");
      void client.invalidateQueries({ queryKey: ["feishu-integration"] });
      void client.invalidateQueries({ queryKey: ["search-suggestions"] });
    },
    onError: () => setSyncError("无法开始同步，请稍后重试"),
  });
  const members = useMemo(
    () =>
      data?.members.filter((m) =>
        m.name.toLowerCase().includes(query.trim().toLowerCase()),
      ) || [],
    [data, query],
  );
  const latest = data?.runs.find((r) => r.status === "success");
  const failed = data?.runs[0]?.status === "failed";
  const active =
    data?.members.filter(
      (m) => m.directoryStatus === "active" && !m.deactivatedAt,
    ).length || 0;
  const pages = Math.max(1, Math.ceil(members.length / 20));
  const currentPage = Math.min(page, pages);
  return (
    <Stack gap="lg">
      <Group justify="space-between" wrap="wrap">
        <div>
          <Title order={1} size="h2">
            飞书集成
          </Title>
          <Text size="sm" c="dimmed" mt={6}>
            成员与身份统一使用飞书，文档权限由空间管理员设置。
          </Text>
        </div>
        <Button
          leftSection={<IconRefresh size={16} />}
          loading={sync.isPending}
          disabled={!data?.enabled}
          onClick={() => sync.mutate()}
        >
          同步成员
        </Button>
      </Group>
      {error && (
        <Alert color="red">
          <Group justify="space-between">
            <Text size="sm">{error.message}</Text>
            <Button size="xs" variant="light" onClick={() => void refetch()}>
              重试
            </Button>
          </Group>
        </Alert>
      )}
      {syncError && <Alert color="red">{syncError}</Alert>}
      {testResult && (
        <Alert color={testResult.success ? "teal" : "orange"}>
          {testResult.text}
        </Alert>
      )}
      {data && !data.enabled && (
        <Alert color="gray">
          成员同步尚未启用，请完成服务端与飞书应用配置。
        </Alert>
      )}
      {failed && (
        <Alert color="orange">
          最近一次同步未完成。保留此前成员数据，超过 15
          分钟未能验证的成员将暂停访问。
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
        <Paper p="lg" withBorder radius="md">
          <Group gap="xs" c="dimmed">
            <IconUsers size={18} />
            <Text size="sm">可用成员</Text>
          </Group>
          <Text fz={28} fw={600} mt="xs">
            {isPending ? "—" : active}
            <Text component="span" fz="sm" c="dimmed" ml="xs">
              / {data?.members.length || 0}
            </Text>
          </Text>
        </Paper>
        <Paper p="lg" withBorder radius="md">
          <Text size="sm" c="dimmed">
            最近成功同步
          </Text>
          <Text fw={500} mt="sm">
            {time(latest?.finishedAt)}
          </Text>
          <Text size="xs" c="dimmed" mt="xs">
            每 5 分钟校准成员状态
          </Text>
        </Paper>
        <Paper p="lg" withBorder radius="md">
          <Group gap="xs" c="dimmed">
            <IconBrandHipchat size={18} />
            <Text size="sm">飞书通知</Text>
          </Group>
          <Badge
            color={data?.notifications.enabled ? "teal" : "gray"}
            variant="light"
            mt="sm"
          >
            {data?.notifications.enabled ? "已启用" : "未启用"}
          </Badge>
          {data?.notifications.enabled && (
            <Text size="xs" c="dimmed" mt="xs">
              已送达{" "}
              {data.notifications.counts.find((c) => c.state === "sent")
                ?.count || 0}{" "}
              · 待发送{" "}
              {data.notifications.counts
                .filter((c) => ["pending", "sending"].includes(c.state))
                .reduce((n, c) => n + c.count, 0)}{" "}
              · 失败{" "}
              {data.notifications.counts.find((c) => c.state === "failed")
                ?.count || 0}
            </Text>
          )}
          <Text size="xs" c="dimmed" mt="xs">
            事件连接：
            {data?.events === "connected"
              ? "已连接"
              : data?.events === "disabled"
                ? "未启用"
                : "连接中"}
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            mt="sm"
            loading={testNotification.isPending}
            disabled={!data?.notifications.enabled}
            onClick={() => testNotification.mutate()}
          >
            向我发送测试通知
          </Button>
        </Paper>
      </SimpleGrid>
      <Paper withBorder radius="md" p="lg">
        <Group justify="space-between" mb="md">
          <Text fw={600}>飞书成员</Text>
          <TextInput
            aria-label="搜索飞书成员"
            placeholder="搜索姓名"
            leftSection={<IconSearch size={16} />}
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setPage(1);
            }}
          />
        </Group>
        <Table.ScrollContainer minWidth={520}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>成员</Table.Th>
                <Table.Th>知识库角色</Table.Th>
                <Table.Th>状态</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {members
                .slice((currentPage - 1) * 20, currentPage * 20)
                .map((m) => (
                  <Table.Tr key={m.id}>
                    <Table.Td>
                      <Group gap="sm">
                        <CustomAvatar
                          size={32}
                          name={m.name}
                          avatarUrl={m.avatarUrl}
                        />
                        <Text size="sm">{m.name}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {(
                        {
                          owner: "所有者",
                          admin: "管理员",
                          member: "成员",
                        } as Record<string, string>
                      )[m.role] || "成员"}
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        variant="light"
                        color={
                          m.deactivatedAt
                            ? "gray"
                            : m.directoryStatus === "active"
                              ? "teal"
                              : "orange"
                        }
                      >
                        {m.deactivatedAt
                          ? "知识库已停用"
                          : names[m.directoryStatus] || "待同步"}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {!members.length && (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            {isPending
              ? "正在读取成员…"
              : query
                ? "没有找到成员"
                : "暂无已同步成员"}
          </Text>
        )}
        {pages > 1 && (
          <Pagination
            total={pages}
            value={currentPage}
            onChange={setPage}
            mt="md"
          />
        )}
      </Paper>
      <Accordion variant="contained" radius="md">
        <Accordion.Item value="runs">
          <Accordion.Control>同步记录</Accordion.Control>
          <Accordion.Panel>
            <Table.ScrollContainer minWidth={600}>
              <Table fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>时间</Table.Th>
                    <Table.Th>来源</Table.Th>
                    <Table.Th>结果</Table.Th>
                    <Table.Th>变更</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data?.runs.map((r) => (
                    <Table.Tr key={r.id}>
                      <Table.Td>{time(r.startedAt)}</Table.Td>
                      <Table.Td>{sources[r.source] || r.source}</Table.Td>
                      <Table.Td>
                        <Badge
                          variant="light"
                          color={
                            r.status === "success"
                              ? "teal"
                              : r.status === "failed"
                                ? "red"
                                : "gray"
                          }
                        >
                          {r.status === "success"
                            ? "成功"
                            : r.status === "failed"
                              ? "失败"
                              : "进行中"}
                        </Badge>
                        {r.errorCode && (
                          <Text size="xs" c="dimmed" mt={4}>
                            {errors[r.errorCode] || r.errorCode}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        新增 {r.added} · 校准 {r.updated} · 不可用 {r.blocked}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}
