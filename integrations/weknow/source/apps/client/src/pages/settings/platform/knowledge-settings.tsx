import React, { useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Accordion,
} from "@mantine/core";
import AgentConnect from "./agent-connect";
import {
  IconLink,
  IconMail,
  IconPlugConnected,
  IconCopy,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
async function api(path: string, body?: any) {
  const r = await fetch("/api/knowledge/" + path, {
    credentials: "same-origin",
    ...(body !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const v = await r.json();
  if (!r.ok)
    throw new Error(
      typeof v.message === "string" ? v.message : "操作未完成，请重试。",
    );
  return v.data ?? v;
}
const label: Record<string, string> = {
  "knowledge:read": "阅读",
  "knowledge:write": "编辑",
  "knowledge:manage": "管理",
  "knowledge:mail": "邮件材料",
};
export default function KnowledgeSettings() {
  const client = useQueryClient(),
    connections = useQuery({
      queryKey: ["knowledge-connections"],
      queryFn: () => api("oauth/connections"),
    }),
    profile = useQuery({
      queryKey: ["knowledge-mail"],
      queryFn: () => api("mail/profile"),
    });
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [requested, setRequested] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function action(fn: () => Promise<any>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await client.invalidateQueries({ queryKey: ["knowledge-connections"] });
      await client.invalidateQueries({ queryKey: ["knowledge-mail"] });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const endpoint = window.location.origin + "/mcp";
  return (
    <Stack maw={850} mx="auto" px="md" py="xl" gap="xl">
      <div>
        <Title order={2}>连接与通知</Title>
        <Text c="dimmed" mt={6}>
          管理 Agent 连接与文档提醒。
        </Text>
      </div>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      <Paper withBorder p="xl" radius="lg">
        <Stack>
          <Group>
            <IconPlugConnected size={23} />
            <Title order={3}>API 与 MCP</Title>
          </Group>
          <Group justify="space-between" mb="xs">
            <AgentConnect endpoint={endpoint} />
            <Text size="sm" c="dimmed">
              按空间权限操作文档、目录与评论
            </Text>
          </Group>
          <Accordion variant="default">
            <Accordion.Item value="manual">
              <Accordion.Control>手动接入与 API</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Code style={{ overflowWrap: "anywhere" }}>{endpoint}</Code>
                    <Button
                      variant="light"
                      size="xs"
                      leftSection={<IconCopy size={14} />}
                      onClick={() =>
                        navigator.clipboard
                          .writeText(endpoint)
                          .then(() =>
                            notifications.show({ message: "已复制 MCP 地址" }),
                          )
                          .catch(() => setError("复制未完成，请手动复制。"))
                      }
                    >
                      复制地址
                    </Button>
                  </Group>
                  <Text size="sm" c="dimmed">
                    客户端选择 Streamable HTTP 与
                    OAuth，使用飞书登录后确认权限。
                  </Text>
                  <Anchor
                    href="/api/knowledge/v1/openapi.json"
                    target="_blank"
                    size="sm"
                  >
                    查看 API 文档
                  </Anchor>
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          {connections.isError && (
            <Alert color="red">无法读取连接，请刷新重试。</Alert>
          )}
          {connections.data?.length ? (
            connections.data.map((c: any) => (
              <Paper key={c.id} withBorder p="md" radius="md">
                <Group justify="space-between">
                  <div>
                    <Text fw={600}>{c.metadata.client_name}</Text>
                    <Group gap={6} mt={6}>
                      {c.scopes.map((s: string) => (
                        <Badge key={s} variant="light" color="gray">
                          {label[s]}
                        </Badge>
                      ))}
                    </Group>
                    <Text size="xs" c="dimmed" mt={6}>
                      {c.revokedAt
                        ? "已撤销"
                        : new Date(c.expiresAt).getTime() < Date.now()
                          ? "已过期"
                          : "有效至 " +
                            new Date(c.expiresAt).toLocaleDateString()}
                    </Text>
                  </div>
                  {!c.revokedAt && (
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      disabled={busy}
                      onClick={() =>
                        action(() =>
                          api("oauth/connections/" + c.id + "/revoke", {}),
                        )
                      }
                    >
                      撤销
                    </Button>
                  )}
                </Group>
              </Paper>
            ))
          ) : connections.isLoading ? (
            <Text c="dimmed" size="sm">
              正在加载…
            </Text>
          ) : !connections.isError ? (
            <Text c="dimmed" size="sm">
              还没有已授权的连接
            </Text>
          ) : null}
        </Stack>
      </Paper>
      <Paper withBorder p="xl" radius="lg">
        <Stack>
          <Group>
            <IconMail size={23} />
            <Title order={3}>邮件提醒</Title>
          </Group>
          {profile.isError ? (
            <Alert color="red">无法读取通知设置，请刷新重试。</Alert>
          ) : profile.isPending ? (
            <Text c="dimmed" size="sm">
              正在读取通知设置…
            </Text>
          ) : !profile.data?.available ? (
            <Text c="dimmed" size="sm">
              邮件通道尚未启用，飞书通知可以照常使用。
            </Text>
          ) : (
            <>
              {profile.data.verifiedAt && (
                <Switch
                  label={"文档提及提醒 · " + profile.data.email}
                  checked={profile.data.enabled}
                  disabled={busy}
                  onChange={(e) => {
                    const enabled = e.currentTarget.checked;
                    void action(() => api("mail/preferences", { enabled }));
                  }}
                />
              )}
              <TextInput
                label={profile.data.verifiedAt ? "更换通知邮箱" : "通知邮箱"}
                placeholder="name@example.com"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                disabled={busy}
              />
              {requested && (
                <TextInput
                  label="邮箱验证码"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.currentTarget.value)}
                  disabled={busy}
                />
              )}
              <Group>
                <Button
                  variant="light"
                  loading={busy}
                  disabled={!email}
                  onClick={() =>
                    action(async () => {
                      await api("mail/verify-request", { email });
                      setRequested(true);
                    })
                  }
                >
                  发送验证码
                </Button>
                {requested && (
                  <Button
                    disabled={busy || code.length !== 6}
                    onClick={() =>
                      action(async () => {
                        await api("mail/verify", { code });
                        setRequested(false);
                        setCode("");
                        setEmail("");
                      })
                    }
                  >
                    验证并启用
                  </Button>
                )}
              </Group>
            </>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
