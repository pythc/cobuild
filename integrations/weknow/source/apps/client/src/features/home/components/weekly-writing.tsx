import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import {
  Avatar,
  Button,
  Group,
  Paper,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { IconInfoCircle, IconPencil, IconUser } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import api from "@/lib/api-client";
import classes from "./weekly-writing.module.css";

export type WritingMetric = "characters" | "edits" | "createdPages";
export interface WritingMember {
  userId: string;
  name: string;
  avatarUrl?: string;
  characters: number;
  edits: number;
  createdPages: number;
}
export interface WeeklyWritingData {
  start: string;
  end: string;
  trackingSince: string;
  members: WritingMember[];
}
export function rankWriting(members: WritingMember[], metric: WritingMetric) {
  let rank = 0,
    previous: number | undefined;
  return [...members]
    .sort(
      (a, b) =>
        b[metric] - a[metric] ||
        a.name.localeCompare(b.name, "zh-CN") ||
        a.userId.localeCompare(b.userId),
    )
    .map((member, index) => {
      if (member[metric] !== previous) rank = index + 1;
      previous = member[metric];
      return { ...member, rank };
    });
}
const day = (date: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
  }).format(new Date(date));
const trackingMoment = (date: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(date));
export function WeeklyWritingCard({
  data,
  loading,
  error,
  onRetry,
}: {
  data?: WeeklyWritingData;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<WritingMetric>("characters");
  const ranked = rankWriting(data?.members || [], metric);
  const unit =
    metric === "characters"
      ? t("Writing character unit")
      : metric === "edits"
        ? t("Writing edit unit")
        : t("Writing page unit");
  const explanation = t(
    "New pages count all pages created this week, including subpages. Characters and edits are recorded from the tracking start. Edits to the same page within five minutes count once. Only accessible team documents are included; personal knowledge is excluded.",
  );
  return (
    <Paper
      component="aside"
      withBorder
      radius="lg"
      p="lg"
      className={classes.card}
      aria-label={t("Weekly writing")}
    >
      <Group justify="space-between" mb={4}>
        <Group gap={8}>
          <IconPencil size={18} className={classes.pen} />
          <Title order={2} size="h5">
            {t("Weekly writing")}
          </Title>
        </Group>
        <Tooltip label={explanation} multiline w={250} withArrow>
          <UnstyledButton
            className={classes.info}
            aria-label={t("Statistics rules")}
          >
            <IconInfoCircle size={16} />
          </UnstyledButton>
        </Tooltip>
      </Group>
      <Text size="xs" c="dimmed" mb="md">
        {data
          ? `${day(data.start)} — ${day(new Date(Date.parse(data.end) - 1).toISOString())}`
          : t("This week")}{" "}
        · {t("Beijing time")}
      </Text>
      <SegmentedControl
        fullWidth
        size="xs"
        radius="md"
        value={metric}
        onChange={(v) => setMetric(v as WritingMetric)}
        aria-label={t("Writing metric")}
        data={[
          { value: "characters", label: t("Net characters") },
          { value: "edits", label: t("Edits") },
          { value: "createdPages", label: t("New pages") },
        ]}
      />
      {loading ? (
        <Stack gap="md" mt="lg" aria-label={t("Loading")}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Group key={n} wrap="nowrap">
              <Skeleton circle h={32} w={32} />
              <Skeleton h={18} flex={1} />
            </Group>
          ))}
        </Stack>
      ) : error ? (
        <Stack gap={6} align="center" py="xl">
          <Text size="sm" c="dimmed">
            {t("Could not load writing statistics")}
          </Text>
          <Button size="xs" variant="subtle" onClick={onRetry}>
            {t("Try again")}
          </Button>
        </Stack>
      ) : (
        <>
          <ol className={classes.list} aria-label={t("Member writing ranking")}>
            {ranked.map((member) => (
              <li key={member.userId} className={classes.row}>
                <span
                  className={classes.rank}
                  data-leading={
                    (member.rank <= 3 && member[metric] > 0) || undefined
                  }
                >
                  {member[metric] === 0
                    ? "—"
                    : String(member.rank).padStart(2, "0")}
                </span>
                <Avatar src={member.avatarUrl} size={32} radius="xl">
                  <IconUser size={17} />
                </Avatar>
                <Text size="sm" fw={500} truncate className={classes.name}>
                  {member.name}
                </Text>
                <div className={classes.value}>
                  <Text size="sm" fw={600}>
                    {new Intl.NumberFormat("zh-CN").format(member[metric])}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {unit}
                  </Text>
                </div>
              </li>
            ))}
          </ol>
          {!ranked.length && (
            <Text c="dimmed" size="sm" ta="center" py="xl">
              {t("No writing activity yet")}
            </Text>
          )}
          {metric === "createdPages" ? (
            <Text size="xs" c="dimmed" mt="sm">
              {t("All pages created this week, including subpages")}
            </Text>
          ) : (
            data?.trackingSince &&
            Date.parse(data.trackingSince) > Date.parse(data.start) && (
              <Text size="xs" c="dimmed" mt="sm">
                {t("Character and edit tracking since")} {trackingMoment(data.trackingSince)}
              </Text>
            )
          )}
        </>
      )}
    </Paper>
  );
}
export default function WeeklyWriting() {
  const user = useAtomValue(userAtom);
  const query = useQuery({
    queryKey: ["weekly-writing", user?.workspaceId, user?.id],
    enabled: !!user,
    queryFn: async () =>
      (await api.get<WeeklyWritingData>("/writing/weekly")).data,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return (
    <WeeklyWritingCard
      data={query.data}
      loading={query.isPending}
      error={query.isError}
      onRetry={() => void query.refetch()}
    />
  );
}
