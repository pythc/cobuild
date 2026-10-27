import { useReadingQuery } from "@/features/home/queries/reading-query";
import { FileIcon } from "@/features/office/file-icon";
import { buildPageUrl } from "@/features/page/page.utils";
import { Button, Skeleton, Tooltip } from "@mantine/core";
import { usePersonalKnowledgeQuery } from "@/features/space/queries/personal-space-query";
import { useEffect, useState } from "react";
import { ScrollArea, Text, Divider } from "@mantine/core";
import {
  IconHome,
  IconLock,
  IconStar,
  IconLayoutGrid,
  IconSettings,
  IconTemplate,
} from "@tabler/icons-react";
import { Link, useLocation } from "react-router-dom";
import classes from "./global-sidebar.module.css";
import { useTranslation } from "react-i18next";
import { useAtom } from "jotai";
import { mobileSidebarAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar";
import { useFavoritesQuery } from "@/features/favorite/queries/favorite-query";
import { getSpaceUrl } from "@/lib/config";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { AvatarIconType } from "@/features/attachments/types/attachment.types";
import { useHasFeature } from "@/platform/core-only";
import { Feature } from "@/platform/core-only";

export default function GlobalSidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const [active, setActive] = useState(location.pathname);
  const [mobileSidebarOpened] = useAtom(mobileSidebarAtom);
  const toggleMobileSidebar = useToggleSidebar(mobileSidebarAtom);
  const personal = usePersonalKnowledgeQuery();
  const reading = useReadingQuery();
  const hasTemplates = useHasFeature(Feature.TEMPLATES);

  const mainNavItems = [
    { label: "Home", icon: IconHome, path: "/home" },
    { label: "Favorites", icon: IconStar, path: "/favorites" },
    { label: "Spaces", icon: IconLayoutGrid, path: "/spaces" },
    {
      label: "Templates",
      icon: IconTemplate,
      path: "/templates",
      disabled: !hasTemplates,
    },
  ];
  const { data: favoriteSpacesData, isPending: isFavoritesPending } =
    useFavoritesQuery("space");
  const favoriteSpaces =
    favoriteSpacesData?.pages.flatMap((p) => p.items) ?? [];
  const sortedFavoriteSpaces = [...favoriteSpaces]
    .filter((fav) => fav.space)
    .sort((a, b) => {
      const cmp = (a.space!.name ?? "").localeCompare(
        b.space!.name ?? "",
        undefined,
        { sensitivity: "base" },
      );
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });

  useEffect(() => {
    setActive(location.pathname);
  }, [location.pathname]);

  const handleNavClick = () => {
    if (mobileSidebarOpened) {
      toggleMobileSidebar();
    }
  };

  return (
    <div className={classes.navbar}>
      <ScrollArea w="100%" style={{ flex: 1 }}>
        <div className={classes.section}>
          {personal.data && (
            <Link
              className={classes.link}
              to={getSpaceUrl(personal.data.slug)}
              onClick={handleNavClick}
            >
              <IconLock className={classes.linkIcon} stroke={2} />
              <span>我的知识库</span>
            </Link>
          )}
          {personal.isError && (
            <button
              className={classes.link}
              onClick={() => void personal.refetch()}
            >
              <IconLock className={classes.linkIcon} />
              <span>重试打开我的知识库</span>
            </button>
          )}
          {mainNavItems
            .filter((item) => !item.disabled)
            .map((item) => (
              <Link
                key={item.label}
                className={classes.link}
                data-active={active === item.path || undefined}
                aria-current={active === item.path ? "page" : undefined}
                to={item.path}
                onClick={handleNavClick}
              >
                <item.icon className={classes.linkIcon} stroke={2} />
                <span>{t(item.label)}</span>
              </Link>
            ))}
        </div>

        <Divider my="xs" />
        <div className={classes.section}>
          <Text component="h2" className={classes.sectionHeader}>
            {t("Favorite spaces")}
          </Text>
          {!isFavoritesPending && sortedFavoriteSpaces.length === 0 ? (
            <Text size="xs" c="dimmed" pl="xs" py={4}>
              {t("Favorite spaces appear here")}
            </Text>
          ) : (
            <>
              {sortedFavoriteSpaces.slice(0, 10).map((fav) => (
                <Link
                  key={fav.id}
                  className={classes.spaceItem}
                  to={getSpaceUrl(fav.space!.slug)}
                  onClick={handleNavClick}
                >
                  <CustomAvatar
                    name={fav.space!.name}
                    avatarUrl={fav.space!.logo}
                    type={AvatarIconType.SPACE_ICON}
                    color="initials"
                    variant="filled"
                    size={20}
                  />
                  <Text size="sm" fw={500} lineClamp={1}>
                    {fav.space!.name}
                  </Text>
                </Link>
              ))}
              {sortedFavoriteSpaces.length > 10 && (
                <Link
                  className={classes.spaceItem}
                  to="/spaces"
                  onClick={handleNavClick}
                >
                  <Text size="xs" c="dimmed">
                    {t("View all")}
                  </Text>
                </Link>
              )}
            </>
          )}
        </div>
        <Divider my="xs" />
        <div className={classes.section} aria-label="继续阅读">
          <Text component="h2" className={classes.sectionHeader}>
            继续阅读
          </Text>
          {reading.isPending ? (
            <Skeleton height={24} my="xs" />
          ) : reading.isError ? (
            <Button
              variant="subtle"
              size="xs"
              onClick={() => void reading.refetch()}
            >
              重试加载最近访问
            </Button>
          ) : !reading.data?.items.length ? (
            <Text size="xs" c="dimmed" px="xs">
              最近访问的页面将显示在这里
            </Text>
          ) : (
            reading.data.items.slice(0, 10).map((page) => (
              <Tooltip
                key={page.id}
                label={page.space.name + " · " + (page.title || "未命名")}
                position="right"
              >
                <Link
                  className={classes.spaceItem}
                  to={buildPageUrl(page.space.slug, page.slugId, page.title)}
                  onClick={handleNavClick}
                >
                  <span
                    style={{
                      width: 20,
                      flexShrink: 0,
                      display: "inline-flex",
                      justifyContent: "center",
                    }}
                  >
                    <FileIcon
                      type={page.nodeType}
                      ext={page.fileExtension}
                      size={18}
                    />
                  </span>
                  <Text size="sm" fw={500} lineClamp={1}>
                    {page.title || "未命名"}
                  </Text>
                </Link>
              </Tooltip>
            ))
          )}
        </div>
      </ScrollArea>

      <div className={classes.bottomSection}>
        <Link
          className={classes.link}
          data-active={active.startsWith("/settings") || undefined}
          aria-current={active.startsWith("/settings") ? "page" : undefined}
          to="/settings/account/profile"
          onClick={handleNavClick}
        >
          <IconSettings className={classes.linkIcon} stroke={2} />
          <span>{t("Settings")}</span>
        </Link>
      </div>
    </div>
  );
}
