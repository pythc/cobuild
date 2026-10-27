import { MemberCard } from "./member-card";
import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { ActionIcon, Anchor, Text } from "@mantine/core";
import { FileIcon } from "@/features/office/file-icon";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { useSharePageQuery } from "@/features/share/queries/share-query.ts";
import { usePublicSpacePageQuery } from "@/features/public-space/queries/public-space-query.ts";
import {
  buildPageUrl,
  buildPublicSpaceUrl,
  buildSharedPageUrl,
} from "@/features/page/page.utils.ts";
import { extractPageSlugId } from "@/lib";
import classes from "./mention.module.css";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { useFeishuMember } from "@/features/user/queries/feishu-member-query";

export default function MentionView(props: NodeViewProps) {
  const { node } = props;
  const { label, entityType, entityId, slugId, anchorId } = node.attrs;
  const isPageMention = entityType === "page";
  const { spaceSlug, pageSlug } = useParams();
  const { shareId } = useParams();
  const navigate = useNavigate();

  const location = useLocation();
  const isShareRoute = location.pathname.startsWith("/share");
  const isPublicSpaceRoute = location.pathname.startsWith("/docs/");
  const { data: member } = useFeishuMember(
    entityId,
    entityType === "user" && !isShareRoute && !isPublicSpaceRoute,
  );

  const {
    data: page,
    isLoading,
    isError,
  } = usePageQuery({
    pageId:
      isPageMention && !isShareRoute && !isPublicSpaceRoute ? slugId : null,
  });

  const { data: sharedPage } = useSharePageQuery({
    pageId: isPageMention && isShareRoute ? slugId : undefined,
  });

  // Without the slugId guard the request resolves to the space home, which
  // would render a mention pointing at the wrong page.
  const { data: publicPageData } = usePublicSpacePageQuery({
    spaceSlug:
      isPageMention && isPublicSpaceRoute && slugId ? spaceSlug : undefined,
    pageSlugId: slugId,
    contentless: true,
  });

  const currentPageSlugId = extractPageSlugId(pageSlug);
  const isSamePage = currentPageSlugId === slugId;

  const handleClick = (e: React.MouseEvent) => {
    if (isSamePage && anchorId) {
      e.preventDefault();
      const element = document.querySelector(`[id="${anchorId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "start" });
        navigate(`#${anchorId}`, { replace: true });
      }
    }
  };

  const targetPage = isShareRoute
    ? sharedPage?.page
    : isPublicSpaceRoute
      ? publicPageData?.page
      : page;
  const fileIcon = (
    <FileIcon
      type={targetPage?.isBase ? "base" : targetPage?.nodeType || "page"}
      ext={targetPage?.fileExtension}
      size={18}
      color="currentColor"
    />
  );

  const sharePageTitle = sharedPage?.page?.title || label;

  const shareSlugUrl = buildSharedPageUrl({
    shareId,
    pageSlugId: slugId,
    pageTitle: sharePageTitle,
    anchorId,
  });

  return (
    <NodeViewWrapper style={{ display: "inline" }} data-drag-handle>
      {entityType === "user" && (
        <MemberCard
          enabled={!isShareRoute && !isPublicSpaceRoute}
          memberId={entityId}
          name={member?.name || label}
        >
          <Text
            className={classes.userMention}
            component="span"
            data-member-mention={entityId}
          >
            {member?.avatarUrl && (
              <CustomAvatar
                name={member.name}
                avatarUrl={member.avatarUrl}
                size={18}
                component="span"
                style={{
                  display: "inline-flex",
                  verticalAlign: "text-bottom",
                  marginRight: 4,
                }}
              />
            )}
            @{member?.name || label}
          </Text>
        </MemberCard>
      )}

      {isPageMention && isShareRoute && (
        <Anchor
          component={Link}
          fw={500}
          to={shareSlugUrl}
          onClick={handleClick}
          underline="never"
          className={classes.pageMentionLink}
        >
          <ActionIcon
            variant="transparent"
            color="blue"
            component="span"
            size={18}
            style={{ verticalAlign: "text-bottom" }}
          >
            {fileIcon}
          </ActionIcon>
          <span className={classes.pageMentionText}>{sharePageTitle}</span>
        </Anchor>
      )}

      {isPageMention && isPublicSpaceRoute && publicPageData?.page && (
        <Anchor
          component={Link}
          fw={500}
          to={buildPublicSpaceUrl({
            spaceSlug: publicPageData.space?.slug ?? spaceSlug,
            pageSlugId: slugId,
            pageTitle: publicPageData.page.title || label,
            anchorId,
          })}
          onClick={handleClick}
          underline="never"
          className={classes.pageMentionLink}
        >
          <ActionIcon
            variant="transparent"
            color="blue"
            component="span"
            size={18}
            style={{ verticalAlign: "text-bottom" }}
          >
            {fileIcon}
          </ActionIcon>
          <span className={classes.pageMentionText}>
            {publicPageData.page.title || label}
          </span>
        </Anchor>
      )}

      {/* No public URL: the /p/ resolver redirects members to the page and
          funnels anonymous visitors through login first. New tab, so the
          redirect chain never rewrites the docs tab's history. */}
      {isPageMention && isPublicSpaceRoute && !publicPageData?.page && (
        <Anchor
          fw={500}
          href={buildPageUrl(undefined, slugId, label, anchorId)}
          target="_blank"
          rel="noopener noreferrer"
          underline="never"
          className={classes.pageMentionLink}
        >
          <ActionIcon
            variant="transparent"
            color="blue"
            component="span"
            size={18}
            style={{ verticalAlign: "text-bottom" }}
          >
            {fileIcon}
          </ActionIcon>
          <span className={classes.pageMentionText}>{label}</span>
        </Anchor>
      )}

      {isPageMention && !isShareRoute && !isPublicSpaceRoute && isError && (
        <Anchor
          component={Link}
          fw={500}
          to={buildPageUrl(spaceSlug, slugId, label, anchorId)}
          onClick={handleClick}
          underline="never"
          className={classes.pageMentionLink}
        >
          <ActionIcon
            variant="transparent"
            color="blue"
            component="span"
            size={18}
            style={{ verticalAlign: "text-bottom" }}
          >
            {fileIcon}
          </ActionIcon>
          <span className={classes.pageMentionText}>{label}</span>
        </Anchor>
      )}

      {isPageMention && !isShareRoute && !isPublicSpaceRoute && !isError && (
        <Anchor
          component={Link}
          fw={500}
          to={buildPageUrl(
            page?.space?.slug || spaceSlug,
            slugId,
            page?.title || label,
            anchorId,
          )}
          onClick={handleClick}
          underline="never"
          className={classes.pageMentionLink}
        >
          <span className={classes.pageMentionIcon} aria-hidden>
            {fileIcon}
          </span>

          <span className={classes.pageMentionText}>
            {page?.title || label}
          </span>
        </Anchor>
      )}
    </NodeViewWrapper>
  );
}
