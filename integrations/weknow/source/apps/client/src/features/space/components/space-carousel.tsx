import { Text, Card, Group, Button, Skeleton, Title } from "@mantine/core";
import {
  prefetchSpace,
  useGetSpacesQuery,
} from "@/features/space/queries/space-query";
import { getSpaceUrl } from "@/lib/config";
import { Link } from "react-router-dom";
import classes from "./space-carousel.module.css";
import { formatMemberCount } from "@/lib";
import { useTranslation } from "react-i18next";
import {
  IconArrowRight,
  IconBooks,
  IconCode,
  IconSchool,
  IconFolder,
} from "@tabler/icons-react";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { AvatarIconType } from "@/features/attachments/types/attachment.types";

function accentFor(slug: string) {
  const known: Record<string, number> = {
    engineering: 0,
    general: 1,
    projects: 2,
  };
  if (known[slug] !== undefined) return known[slug];
  return (
    [...slug].reduce(
      (hash, letter) => (hash * 31 + letter.charCodeAt(0)) >>> 0,
      0,
    ) % 3
  );
}
const accents = ["blue", "green", "violet"];
export default function SpaceCarousel() {
  const { t } = useTranslation();
  const { data, isPending, isError, refetch } = useGetSpacesQuery({ limit: 6 });
  return (
    <section aria-label={t("Spaces you belong to")}>
      <Group justify="space-between" mb="sm">
        <Group gap="xs">
          <IconBooks size={20} />
          <Title order={2} size="h5">
            {t("Spaces you belong to")}
          </Title>
        </Group>
        <Button
          component={Link}
          to="/spaces"
          variant="subtle"
          rightSection={<IconArrowRight size={16} />}
          size="xs"
        >
          {t("View all spaces")}
        </Button>
      </Group>
      {isError ? (
        <Group>
          <Text size="sm" c="dimmed">
            {t("Could not load spaces.")}
          </Text>
          <Button variant="subtle" size="xs" onClick={() => void refetch()}>
            {t("Try again")}
          </Button>
        </Group>
      ) : (
        <div className={classes.grid}>
          {isPending ? (
            Array.from({ length: 3 }, (_, i) => (
              <Card key={i} radius="lg" withBorder p="lg">
                <Skeleton circle width={40} height={40} />
                <Skeleton mt="md" height={18} />
                <Skeleton mt="sm" height={12} width="70%" />
              </Card>
            ))
          ) : data?.items.length ? (
            data.items.map((space) => {
              const Icon =
                space.slug === "engineering"
                  ? IconCode
                  : space.slug === "general"
                    ? IconSchool
                    : IconFolder;
              return (
                <Card
                  key={space.id}
                  component={Link}
                  to={getSpaceUrl(space.slug)}
                  onMouseEnter={() => prefetchSpace(space.slug, space.id)}
                  p="lg"
                  radius="lg"
                  withBorder
                  className={classes.card}
                  data-accent={accents[accentFor(space.slug)]}
                >
                  <Group justify="space-between" wrap="nowrap">
                    {space.logo ? (
                      <CustomAvatar
                        name={space.name}
                        avatarUrl={space.logo}
                        type={AvatarIconType.SPACE_ICON}
                        size="md"
                      />
                    ) : (
                      <div className={classes.icon}>
                        <Icon size={24} stroke={1.7} />
                      </div>
                    )}
                    <IconArrowRight size={18} className={classes.arrow} />
                  </Group>
                  <Text fw={600} size="md" mt="md" lineClamp={1}>
                    {space.name}
                  </Text>
                  {space.description && (
                    <Text size="sm" c="dimmed" lineClamp={2} mt={4}>
                      {space.description}
                    </Text>
                  )}
                  <Text c="dimmed" size="xs" mt="sm">
                    {formatMemberCount(space.memberCount, t)}
                  </Text>
                </Card>
              );
            })
          ) : (
            <Text size="sm" c="dimmed">
              {t("No spaces yet")}
            </Text>
          )}
        </div>
      )}
    </section>
  );
}
