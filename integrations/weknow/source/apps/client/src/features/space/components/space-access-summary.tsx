import {
  Alert,
  Badge,
  Group,
  Paper,
  Stack,
  Text,
  Accordion,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import api from "@/lib/api-client";
import { spaceRoleData, getSpaceRoleLabel } from "../types/space-role-data";

interface AccessSummary {
  role: string;
  sources: {
    id: string;
    type: "direct" | "group";
    name: string;
    role: string;
    isDefault: boolean;
  }[];
}
export default function SpaceAccessSummary({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation();
  const summary = useQuery({
    queryKey: ["space-access", spaceId],
    queryFn: async () =>
      (await api.post<AccessSummary>("/spaces/access", { spaceId })).data,
    enabled: !!spaceId,
    staleTime: 0,
  });
  return (
    <Paper withBorder radius="md" p="sm" mb="md">
      {summary.isPending ? (
        <Text size="sm" c="dimmed">
          {t("Checking your space access…")}
        </Text>
      ) : summary.isError ? (
        <Alert color="red">
          {t("Could not load access details. Please reopen this dialog.")}
        </Alert>
      ) : (
        <Stack gap={6}>
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              {t("Your space access")}
            </Text>
            <Badge variant="light">
              {t(getSpaceRoleLabel(summary.data.role) ?? "Unknown")}
            </Badge>
          </Group>
          {summary.data.sources.map((source) => (
            <Group key={source.type + source.id} gap={6} wrap="wrap">
              <Text size="xs" c="dimmed">
                {source.type === "direct"
                  ? t("Direct access")
                  : t("Via group") +
                    " · " +
                    (source.isDefault ? t("All members (automatic)") : source.name)}
              </Text>
              <Text size="xs">
                {t(getSpaceRoleLabel(source.role) ?? "Unknown")}
              </Text>
            </Group>
          ))}
          <Text size="xs" c="dimmed">
            {t(
              "When several sources apply, the highest space role takes effect. Page restrictions still apply.",
            )}
          </Text>
        </Stack>
      )}
      <Accordion variant="default" mt={4}>
        <Accordion.Item value="roles">
          <Accordion.Control py={4}>
            <Text size="xs">{t("What can each role do?")}</Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap={8}>
              {spaceRoleData.map((role) => (
                <div key={role.value}>
                  <Text size="sm" fw={600}>
                    {t(role.label)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t(role.description)}
                  </Text>
                </div>
              ))}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Paper>
  );
}
