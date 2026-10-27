import React, { useEffect, useState } from "react";
import { beginAutomaticLogin } from "./login-continuation";
import { Button, Text, Title, Stack, Alert, Anchor } from "@mantine/core";
import { BrandMark } from "@/platform/Brand";
import { getRedirectParam } from "@/lib/app-route";
import "./feishu-login.css";

export default function LoginPage() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [unified, setUnified] = useState(false);
  const [failed, setFailed] = useState(false);
  const error = new URLSearchParams(window.location.search).get("error");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/identity/status", {
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(async (r) => {
        const enabled = (r.data ?? r).enabled === true;
        setUnified(enabled);
        if (enabled) {
          setReady(true);
          return;
        }
        const old = await fetch("/api/auth/feishu/status");
        if (!old.ok) throw new Error();
        const v = await old.json();
        setReady((v.data ?? v).enabled === true);
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setReady(false);
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, []);
  function signIn() {
    setPending(true);
    const query = new URLSearchParams();
    const redirect = getRedirectParam();
    if (redirect) query.set("redirect", redirect);
    window.location.assign(
      (unified ? "/api/auth/identity/login" : "/api/auth/feishu/login") +
        (query.size ? "?" + query.toString() : ""),
    );
  }
  useEffect(() => {
    try {
      if (
        ready === true &&
        unified &&
        beginAutomaticLogin(window.location.search, window.sessionStorage)
      )
        signIn();
    } catch {
      /* Keep the explicit login button available in restricted browsers. */
    }
  }, [ready, unified]);
  return (
    <main className="lab-login">
      <section className="lab-login-card" aria-labelledby="login-title">
        <Anchor className="lab-login-brand" href="/home" underline="never">
          <BrandMark size={38} />
          <span>WeKnow</span>
        </Anchor>
        <Stack gap="sm" mt={36} mb={30}>
          <Title order={1} id="login-title" size={30} fw={600}>
            欢迎来到 WeKnow
          </Title>
          <Text c="dimmed" size="sm">
            使用飞书账号，继续你的工作。
          </Text>
        </Stack>
        {error && (
          <Alert color="red" mb="md" role="alert">
            {error === "organization"
              ? "仅限 110lab 组织成员访问。"
              : error === "denied"
                ? "你已取消授权，可以重新登录。"
                : error === "disabled"
                  ? "账号已停用，请联系管理员。"
                  : "登录未完成，请重试。"}
          </Alert>
        )}
        {ready === false && (
          <Alert color="gray" mb="md" role="status">
            {failed
              ? "暂时无法连接登录服务，请刷新重试。"
              : "飞书登录尚未配置，请联系管理员。"}
          </Alert>
        )}
        <Button
          size="lg"
          fullWidth
          loading={ready === null || pending}
          disabled={ready !== true}
          onClick={signIn}
          leftSection={
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M3 4.5L11.5 12L18 4.5H3Z"
                fill="currentColor"
                opacity=".6"
              />
              <path d="M4 10L10.5 16H21L14.5 10H4Z" fill="currentColor" />
              <path
                d="M10.5 16L17 21L21 16H10.5Z"
                fill="currentColor"
                opacity=".8"
              />
            </svg>
          }
        >
          使用飞书登录
        </Button>
        <Text c="dimmed" size="xs" mt="xl" ta="center">
          一个账号，连接 110lab
        </Text>
      </section>
    </main>
  );
}
