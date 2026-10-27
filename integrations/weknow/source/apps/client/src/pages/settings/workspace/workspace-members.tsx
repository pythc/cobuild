import React from "react";
import { Title, Text, Space } from "@mantine/core";
import WorkspaceMembersTable from "@/features/workspace/components/members/components/workspace-members-table";
export default function WorkspaceMembers() {
  return (
    <>
      <Title order={1} size="h2" mb="sm">
        成员
      </Title>
      <Text size="sm" c="dimmed">
        组织成员首次通过飞书登录后自动加入。
      </Text>
      <Space h="lg" />
      <WorkspaceMembersTable />
    </>
  );
}
