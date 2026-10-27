import {
  Button,
  Code,
  Group,
  Modal,
  Stack,
  Text,
  Title,
  Accordion,
} from "@mantine/core";
import { IconCopy, IconPlugConnected } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useState } from "react";

export function knowledgeConnectionPrompt(endpoint: string): string {
  return `请连接当前 110lab 知识库：${endpoint}。使用已安装的 110lab 插件调用 kb_connect，返回授权链接后由我本人完成飞书登录并确认知识库权限，不要代我点击允许。然后调用 kb_connection_status 和 kb_test_connection，报告实际连接结果。不要修改文档或发送消息。如果当前客户端没有 110lab 插件或知识库工具，请明确告诉我需要添加哪个连接，不要声称已连接。`;
}
export default function AgentConnect({ endpoint }: { endpoint: string }) {
  const [opened, setOpened] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const prompt = knowledgeConnectionPrompt(endpoint);
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setError("");
      notifications.show({ message: "连接指令已复制，发给 110 插件即可" });
    } catch {
      setError("复制失败，请选中下方指令手动复制。");
    }
  }
  return (
    <>
      <Button
        leftSection={<IconPlugConnected size={17} />}
        onClick={() => {
          setCopied(false);
          setError("");
          setOpened(true);
        }}
      >
        连接 110 插件
      </Button>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title="连接 110 插件"
        centered
        radius="lg"
      >
        <Stack gap="md">
          <div>
            <Title order={3} size="h6">
              1. 把连接指令发给插件
            </Title>
            <Text size="sm" c="dimmed" mt={5}>
              在已安装 110 插件的 Agent 对话中粘贴，它会生成授权链接。
            </Text>
          </div>
          <Group>
            <Button onClick={copy} leftSection={<IconCopy size={16} />}>
              {copied ? "再次复制连接指令" : "复制连接指令"}
            </Button>
            <Text size="xs" c="dimmed">
              {copied
                ? "已复制，等待你在 Agent 中继续"
                : "无需手动填写连接配置"}
            </Text>
          </Group>
          {error && (
            <Text size="sm" c="red" role="alert">
              {error}
            </Text>
          )}
          <div>
            <Title order={3} size="h6">
              2. 完成飞书授权
            </Title>
            <Text size="sm" c="dimmed" mt={5}>
              打开 Agent 返回的链接，确认知识库权限。连接成功后会显示在本页。
            </Text>
          </div>
          <Accordion variant="contained">
            <Accordion.Item value="prompt">
              <Accordion.Control>查看完整连接指令</Accordion.Control>
              <Accordion.Panel>
                <Code
                  block
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {prompt}
                </Code>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          <Text size="xs" c="dimmed">
            连接知识库不会扩大原有空间权限。
          </Text>
        </Stack>
      </Modal>
    </>
  );
}
