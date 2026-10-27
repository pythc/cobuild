import React, { useEffect, useState } from "react";
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { BrandMark } from "@/platform/Brand";
import "./feishu-login.css";

export default function KnowledgeConnect() {
  const request = new URLSearchParams(window.location.search).get("request");
  const [preview, setPreview] = useState<any>(),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    if (!request || !/^[a-f0-9-]{36}$/.test(request)) {
      setError("连接请求无效，请从客户端重新发起。");
      return;
    }
    fetch("/api/knowledge/oauth/requests/" + request, {
      credentials: "same-origin",
      signal: c.signal,
    })
      .then(async (r) => {
        if (r.status === 401) {
          window.location.assign(
            "/login?" +
              new URLSearchParams({
                redirect: window.location.pathname + window.location.search,
              }),
          );
          return;
        }
        if (!r.ok)
          throw new Error("连接已过期或不属于这个浏览器，请从客户端重新发起。");
        return r.json();
      })
      .then((v) => {
        if (v) {
          const data = v.data ?? v;
          setPreview(data);
          setSelected(data.scopes.map((s: any) => s.id));
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [request]);
  async function decide(approve: boolean) {
    setPending(true);
    setError("");
    try {
      const r = await fetch(
        "/api/knowledge/oauth/requests/" + request + "/resolve",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approve, scopes: selected }),
        },
      );
      if (!r.ok) throw new Error("连接未完成，请刷新后重试。");
      const v = await r.json();
      window.location.assign((v.data ?? v).redirectUrl);
    } catch (e: any) {
      setError(e.message);
      setPending(false);
    }
  }
  return (
    <main className="lab-login">
      <Paper className="lab-login-card" style={{ maxWidth: 520 }}>
        <Group gap="sm">
          <BrandMark size={34} />
          <Text fw={650} size="xl">
            WeKnow
          </Text>
        </Group>
        <Title order={1} size={27} mt={30}>
          连接知识库
        </Title>
        {error && (
          <Alert color="red" mt="md" role="alert">
            {error}
          </Alert>
        )}
        {preview ? (
          <Stack gap="lg" mt="xl">
            <Text>
              <b>{preview.clientName}</b> 请求访问知识库。
            </Text>
            <Group>
              <Avatar src={preview.user.avatarUrl} radius="xl" />
              <Text>{preview.user.name}</Text>
            </Group>
            <Stack gap="sm">
              {preview.scopes.map((s: any) => (
                <Checkbox
                  key={s.id}
                  label={s.label}
                  checked={selected.includes(s.id)}
                  onChange={(e) =>
                    setSelected(
                      e.currentTarget.checked
                        ? [...selected, s.id]
                        : selected.filter((x) => x !== s.id),
                    )
                  }
                />
              ))}
            </Stack>
            <Text c="dimmed" size="sm">
              应用只能访问你当前有权限的内容。你可以随时在「连接与通知」中撤销。
            </Text>
            <Group grow>
              <Button
                variant="default"
                disabled={pending}
                onClick={() => decide(false)}
              >
                取消
              </Button>
              <Button
                loading={pending}
                disabled={!selected.length}
                onClick={() => decide(true)}
              >
                允许连接
              </Button>
            </Group>
          </Stack>
        ) : (
          !error && (
            <Text mt="xl" c="dimmed" role="status">
              正在核对连接请求…
            </Text>
          )
        )}
      </Paper>
    </main>
  );
}
