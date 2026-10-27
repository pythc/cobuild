import { useGroupQuery } from "@/features/group/queries/group-query";
import { useParams } from "react-router-dom";
import { Group, Title, Text } from "@mantine/core";
import AddGroupMemberModal from "@/features/group/components/add-group-member-modal";
import React from "react";
import { useDisclosure } from "@mantine/hooks";
import EditGroupModal from "@/features/group/components/edit-group-modal.tsx";
import GroupActionMenu from "@/features/group/components/group-action-menu.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";

export default function GroupDetails() {
  const { t } = useTranslation();
  const { groupId } = useParams();
  const { data: group, isLoading } = useGroupQuery(groupId);
  const [opened, { open, close }] = useDisclosure(false);
  const { isAdmin } = useUserRole();

  return (
    <>
      {group && (
        <div>
          {/* Todo: back navigation */}
          <Title order={4}>
            {group.isDefault ? t("All members (automatic)") : group.name}
          </Title>
          <Text c="dimmed">
            {group.isDefault
              ? t("Membership follows the Feishu directory automatically.")
              : group.isExternal
                ? group.description || t("Managed by your directory provider.")
                : group.description}
          </Text>

          <Group my="md" justify="flex-end">
            {isAdmin && !group.isDefault && !group.isExternal && (
              <>
                <AddGroupMemberModal />
                <GroupActionMenu />
              </>
            )}
          </Group>
        </div>
      )}

      <EditGroupModal opened={opened} onClose={close} />
    </>
  );
}
