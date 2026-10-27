import React from "react";
import { Divider, Text, Title, Group, Stack } from "@mantine/core";
import SessionList from "@/features/session/components/session-list";
import { useAtomValue } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { CustomAvatar } from "@/components/ui/custom-avatar";
export default function AccountSettings() {
  const current = useAtomValue(currentUserAtom);
  const user = current?.user;
  return (
    <>
      <Title order={1} size="h2" mb="xl">
        个人信息
      </Title>
      <Group>
        <CustomAvatar name={user?.name} avatarUrl={user?.avatarUrl} size="lg" />
        <Stack gap={4}>
          <Text fw={600}>{user?.name}</Text>
          <Text c="dimmed" size="sm">
            飞书组织成员
          </Text>
        </Stack>
      </Group>
      <Divider my="xl" />
      <SessionList />
    </>
  );
}
