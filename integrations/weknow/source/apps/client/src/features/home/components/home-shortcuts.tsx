import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import {
  Button,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { IconBookmark, IconSchool, IconArrowRight } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useFavoritesQuery } from "@/features/favorite/queries/favorite-query";
import { findPagesByLabel } from "@/features/label/services/label-service";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import { buildPageUrl, getPageTitle } from "@/features/page/page.utils";
import { PageListIcon } from "@/components/common/page-list-icon";
import { formattedDate } from "@/lib/time";
import classes from "./home-shortcuts.module.css";

function PageShortcut({
  page,
  space,
  date,
}: {
  page: { slugId: string; title: string; icon?: string | null };
  space: { name: string; slug: string };
  date?: string;
}) {
  const { t } = useTranslation();
  return (
    <UnstyledButton
      component={Link}
      to={buildPageUrl(space.slug, page.slugId, page.title)}
      className={classes.pageLink}
    >
      <PageListIcon icon={page.icon} />
      <div className={classes.pageText}>
        <Text fw={500} size="sm" lineClamp={1}>
          {getPageTitle(page.title, false, t)}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={1}>
          {space.name}
          {date ? " · " + formattedDate(new Date(date)) : ""}
        </Text>
      </div>
    </UnstyledButton>
  );
}
function EmptyOrLoading({
  loading,
  error,
  text,
  retry,
}: {
  loading: boolean;
  error: boolean;
  text: string;
  retry: () => void;
}) {
  const { t } = useTranslation();
  if (loading)
    return (
      <Stack gap="sm">
        <Skeleton height={30} />
        <Skeleton height={30} />
      </Stack>
    );
  if (error)
    return (
      <div>
        <Text size="sm" c="dimmed">
          {t("Could not load these pages.")}
        </Text>
        <Button variant="subtle" size="xs" onClick={retry}>
          {t("Try again")}
        </Button>
      </div>
    );
  return (
    <Text size="sm" c="dimmed" py="sm">
      {text}
    </Text>
  );
}
export default function HomeShortcuts() {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const favorites = useFavoritesQuery("page");
  const required = useQuery({
    queryKey: ["home-required-pages", user?.workspaceId, user?.id],
    queryFn: () => findPagesByLabel({ name: "新人必读", limit: 4 }),
    enabled: !!user,
    refetchOnMount: "always",
  });
  const favoriteItems =
    favorites.data?.pages
      .flatMap((p) => p.items)
      .filter((f) => f.page && f.space)
      .slice(0, 4) ?? [];
  return (
    <div className={classes.grid}>
      <Paper
        component="section"
        withBorder
        p="lg"
        radius="lg"
        aria-label={t("Quick access")}
      >
        <Group justify="space-between" mb="sm">
          <Group gap="xs">
            <IconBookmark size={20} />
            <Title order={2} size="h5">
              {t("Quick access")}
            </Title>
          </Group>
          <Button
            component={Link}
            to="/favorites"
            size="xs"
            variant="subtle"
            rightSection={<IconArrowRight size={14} />}
          >
            {t("View all")}
          </Button>
        </Group>
        {favoriteItems.length ? (
          favoriteItems.map((f) => (
            <PageShortcut key={f.id} page={f.page!} space={f.space!} />
          ))
        ) : (
          <EmptyOrLoading
            loading={favorites.isPending}
            error={favorites.isError}
            retry={() => void favorites.refetch()}
            text={t("Favorite a page to keep it here.")}
          />
        )}
      </Paper>
      <Paper
        component="section"
        withBorder
        p="lg"
        radius="lg"
        aria-label={t("New member essentials")}
      >
        <Group justify="space-between" mb="sm">
          <Group gap="xs">
            <IconSchool size={20} />
            <Title order={2} size="h5">
              {t("New member essentials")}
            </Title>
          </Group>
          <Button
            component={Link}
            to="/labels/新人必读"
            size="xs"
            variant="subtle"
            rightSection={<IconArrowRight size={14} />}
          >
            {t("View all")}
          </Button>
        </Group>
        {required.data?.items.length ? (
          required.data.items
            .filter((p) => p.space)
            .map((page) => (
              <PageShortcut
                key={page.id}
                page={{ ...page, title: page.title ?? "" }}
                space={page.space!}
              />
            ))
        ) : (
          <EmptyOrLoading
            loading={required.isPending}
            error={required.isError}
            retry={() => void required.refetch()}
            text={t("Add the 新人必读 label to a page to include it here.")}
          />
        )}
      </Paper>
    </div>
  );
}
