import React from "react";
import { Text, Title, Stack, Anchor, Group } from "@mantine/core";
import { BrandMark } from "@/platform/Brand";
export default function AboutPlatform() {
  return (
    <Stack gap="lg">
      <Group>
        <BrandMark size={40} />
        <Title order={1} size="h2">
          110lab 知识库
        </Title>
      </Group>
      <Text>面向团队的文档与知识协作平台。</Text>
      <Group>
        <Anchor href="/opensource/LICENSE" target="_blank">
          开源许可证
        </Anchor>
        <Anchor href="/opensource/source.tar.gz" download>
          获取本版本源码
        </Anchor>
      </Group>
      <Text c="dimmed" size="xs">
        版本：0.96.0 · 110lab
      </Text>
    </Stack>
  );
}
