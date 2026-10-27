import {
  Text,
  Group,
  ActionIcon,
  Box,
  Space,
  Menu,
  Anchor,
  Tooltip,
} from "@mantine/core";
import {
  IconDots,
  IconSettings,
  IconEye,
  IconEyeOff,
  IconUsers,
} from "@tabler/icons-react";
import StarButton from "@/features/favorite/components/star-button";
import {
  useWatchedSpaceIds,
  useWatchSpaceMutation,
  useUnwatchSpaceMutation,
} from "@/features/space/queries/space-watcher-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import React, { useState } from "react";
import { useDisclosure } from "@mantine/hooks";
import { formatMemberCount } from "@/lib";
import { getSpaceUrl } from "@/lib/config";
import { prefetchSpace } from "@/features/space/queries/space-query";
import { SearchInput } from "@/components/common/search-input";
import Paginate from "@/components/common/paginate";
import SpaceSettingsModal from "@/features/space/components/settings-modal";
import classes from "./all-spaces-list.module.css";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { AvatarIconType } from "@/features/attachments/types/attachment.types.ts";
import { ISpace } from "@/features/space/types/space.types";

function WatchButton({
  spaceId,
  watchedIds,
  size = 16,
}: {
  spaceId: string;
  watchedIds: Set<string>;
  size?: number;
}) {
  const { t } = useTranslation();
  const watchMutation = useWatchSpaceMutation();
  const unwatchMutation = useUnwatchSpaceMutation();
  const isWatching = watchedIds.has(spaceId);
  const isPending = watchMutation.isPending || unwatchMutation.isPending;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isWatching) {
      unwatchMutation.mutate(spaceId);
    } else {
      watchMutation.mutate(spaceId);
    }
  };

  const label = isWatching ? t("Stop watching space") : t("Watch space");

  return (
    <Tooltip label={label} openDelay={250} withArrow>
      <ActionIcon
        variant="subtle"
        color={isWatching ? "blue" : "gray"}
        aria-label={label}
        aria-pressed={isWatching}
        onClick={handleToggle}
        loading={isPending}
      >
        {isWatching ? (
          <IconEyeOff size={size} stroke={2} />
        ) : (
          <IconEye size={size} stroke={2} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}

interface AllSpacesListProps {
  spaces: ISpace[];
  onSearch: (query: string) => void;
  hasPrevPage?: boolean;
  hasNextPage?: boolean;
  onNext: () => void;
  onPrev: () => void;
}

export default function AllSpacesList({
  spaces,
  onSearch,
  hasPrevPage,
  hasNextPage,
  onNext,
  onPrev,
}: AllSpacesListProps) {
  const { t } = useTranslation();
  const watchedIds = useWatchedSpaceIds();
  const [settingsOpened, { open: openSettings, close: closeSettings }] =
    useDisclosure(false);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);

  const handleOpenSettings = (spaceId: string) => {
    setSelectedSpaceId(spaceId);
    openSettings();
  };

  return (
    <Box className={classes.list}>
      <SearchInput onSearch={onSearch} />

      <Space h="md" />

      {spaces.length > 0 ? (
        <Box
          component="ul"
          className={classes.grid}
          aria-label={t("List of spaces in this workspace")}
        >
          {spaces.map((space) => (
            <Box component="li" key={space.id} className={classes.card}>
              <Anchor
                component={Link}
                to={getSpaceUrl(space.slug)}
                underline="never"
                className={classes.cardLink}
                aria-label={space.name}
                onMouseEnter={() => prefetchSpace(space.slug, space.id)}
              >
                <CustomAvatar
                  name={space.name}
                  avatarUrl={space.logo}
                  type={AvatarIconType.SPACE_ICON}
                  color="initials"
                  variant="filled"
                  size={60}
                />
                <Box className={classes.details}>
                  <Text component="h2" className={classes.name}>
                    {space.name}
                  </Text>
                  {space.description && (
                    <Text className={classes.description} lineClamp={4}>
                      {space.description}
                    </Text>
                  )}
                </Box>
              </Anchor>
              <Group
                className={classes.footer}
                justify="space-between"
                wrap="nowrap"
                gap="xs"
              >
                <Group gap={8} wrap="nowrap" className={classes.members}>
                  <IconUsers size={18} stroke={1.8} aria-hidden="true" />
                  <Text size="sm">
                    {formatMemberCount(space.memberCount, t)}
                  </Text>
                </Group>
                <Group gap={4} wrap="nowrap" className={classes.actions}>
                  <StarButton
                    type="space"
                    spaceId={space.id}
                    name={space.name}
                    size={18}
                  />
                  <WatchButton
                    spaceId={space.id}
                    watchedIds={watchedIds}
                    size={18}
                  />
                  <Menu position="bottom-end">
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={t("Space menu")}
                      >
                        <IconDots size={18} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconSettings size={16} />}
                        onClick={() => handleOpenSettings(space.id)}
                      >
                        {t("Space settings")}
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group>
              </Group>
            </Box>
          ))}
        </Box>
      ) : (
        <Text fw={500} c="dimmed" ta="center" py="xl">
          {t("No results found...")}
        </Text>
      )}

      {spaces.length > 0 && (
        <Paginate
          hasPrevPage={hasPrevPage}
          hasNextPage={hasNextPage}
          onNext={onNext}
          onPrev={onPrev}
        />
      )}

      {selectedSpaceId && (
        <SpaceSettingsModal
          spaceId={selectedSpaceId}
          opened={settingsOpened}
          onClose={closeSettings}
        />
      )}
    </Box>
  );
}
