import { useQuery, UseQueryResult } from "@tanstack/react-query";
import {
  searchPage,
  searchAttachments,
} from "@/features/search/services/search-service";
import {
  IAttachmentSearch,
  IPageSearch,
  IPageSearchParams,
} from "@/features/search/types/search.types";

export type UnifiedSearchResult = IPageSearch | IAttachmentSearch;

export interface UseUnifiedSearchParams extends IPageSearchParams {
  contentType?: string;
}

export function useUnifiedSearch(
  params: UseUnifiedSearchParams,
  enabled: boolean = true,
): UseQueryResult<UnifiedSearchResult[], Error> {
  const searchType = params.contentType || "all";
  const isAttachmentSearch = searchType === "attachment";

  return useQuery({
    queryKey: ["unified-search", searchType, params],
    queryFn: async () => {
      // Remove contentType from backend params since it's only used for frontend routing
      const { contentType, ...backendParams } = params;

      if (searchType === "all") {
        const [pages, files] = await Promise.all([
          searchPage(backendParams),
          searchAttachments(backendParams),
        ]);
        return [...pages, ...files];
      }
      if (isAttachmentSearch) {
        return await searchAttachments(backendParams);
      } else {
        return await searchPage(backendParams);
      }
    },
    enabled:
      (!!params.query ||
        (params.labelIds?.length ?? 0) > 0 ||
        !!params.creatorId) &&
      enabled,
    // keep previous results only within the same search type; page results
    // rendered as attachments (or vice versa) crash on missing fields
    placeholderData: (previousData, previousQuery) => {
      if (!params.query && !params.labelIds?.length && !params.creatorId)
        return undefined;
      if (previousQuery && previousQuery.queryKey[1] !== searchType) {
        return undefined;
      }
      return previousData;
    },
  });
}
