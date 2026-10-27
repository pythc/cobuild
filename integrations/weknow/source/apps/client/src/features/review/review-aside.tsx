import { useParams } from "react-router-dom";
import { usePageQuery } from "@/features/page/queries/page-query";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query";
import { extractPageSlugId } from "@/lib";
import { ReviewPanel } from "./review-panel";
export default function ReviewAside() {
  const { pageSlug } = useParams();
  const { data: page } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const { data: space } = useGetSpaceBySlugQuery(page?.space?.slug);
  return page ? (
    <ReviewPanel
      pageId={page.id}
      canEdit={!!page.permissions?.canEdit}
      canComment={
        !!page.permissions?.canEdit ||
        space?.settings?.comments?.allowViewerComments === true
      }
    />
  ) : null;
}
