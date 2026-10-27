import { Spotlight } from "@mantine/spotlight";
import { IconSearch } from "@tabler/icons-react";
import { Group, VisuallyHidden, Text } from "@mantine/core";
import React, { useState, useMemo, useCallback } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { searchSpotlightStore } from "../constants.ts";
import { SearchSpotlightFilters } from "./search-spotlight-filters.tsx";
import { useUnifiedSearch } from "../hooks/use-unified-search.ts";
import { SearchResultItem } from "./search-result-item.tsx";

interface SearchSpotlightProps {
  spaceId?: string;
  store?: typeof searchSpotlightStore;
}
export function SearchSpotlight({
  spaceId,
  store = searchSpotlightStore,
}: SearchSpotlightProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [debouncedSearchQuery] = useDebouncedValue(query, 300);
  const [filters, setFilters] = useState<{
    spaceId?: string | null;
    contentType?: string;
    creatorId?: string | null;
    labelIds?: string[];
    titleOnly?: boolean;
  }>({
    contentType: "all",
  });
  const [openVersion, setOpenVersion] = useState(0);

  // Build unified search params
  const searchParams = useMemo(() => {
    const params: any = {
      query: debouncedSearchQuery,
      contentType: filters.contentType || "all", // Only used for frontend routing
    };

    // Handle space filtering - only pass spaceId if a specific space is selected
    if (filters.spaceId) {
      params.spaceId = filters.spaceId;
    }

    if (filters.creatorId) {
      params.creatorId = filters.creatorId;
    }

    if (filters.labelIds?.length) {
      params.labelIds = filters.labelIds;
    }

    if (filters.titleOnly) {
      params.titleOnly = true;
    }

    return params;
  }, [debouncedSearchQuery, filters]);

  // Community search uses the independently implemented page/attachment search.
  // No Docmost Enterprise AI hook or renderer is imported in this build.
  const { data: searchResults, isFetching } = useUnifiedSearch(
    searchParams,
    true,
  );

  const isFilterBrowse =
    (filters.labelIds?.length ?? 0) > 0 || !!filters.creatorId;
  // while the debounce is pending the empty list is not a settled "no results"
  const isQuerySettled = query === debouncedSearchQuery;

  const resultItems = (searchResults || []).map((result) => (
    <SearchResultItem
      key={("fileName" in result ? "file:" : "page:") + result.id}
      result={result}
      isAttachmentResult={"fileName" in result}
      showSpace={!filters.spaceId}
    />
  ));

  const handleSpotlightOpen = () => {
    setQuery("");
    setFilters({ contentType: "all", spaceId: spaceId ?? null });
    setOpenVersion((version) => version + 1);
  };

  const handleFiltersChange = useCallback(
    (newFilters: any) => {
      setFilters(newFilters);
    },
    [setFilters],
  );

  return (
    <>
      <Spotlight.Root
        size="xl"
        maxHeight={600}
        onSpotlightOpen={handleSpotlightOpen}
        store={store}
        shortcut={spaceId ? null : "mod+k"}
        query={query}
        onQueryChange={setQuery}
        scrollable
        overlayProps={{
          backgroundOpacity: 0.55,
        }}
      >
        <Group gap="xs" px="sm" pt="sm" pb="xs">
          <Spotlight.Search
            placeholder={
              spaceId ? t("Search this space…") : t("Search all spaces…")
            }
            aria-label={
              spaceId ? t("Search this space") : t("Search all spaces")
            }
            leftSection={<IconSearch size={20} stroke={1.5} />}
            style={{ flex: 1 }}
          />
        </Group>

        <div
          style={{
            padding: "4px 16px",
          }}
        >
          <SearchSpotlightFilters
            key={openVersion}
            onFiltersChange={handleFiltersChange}
            spaceId={spaceId}
          />
        </div>

        <VisuallyHidden role="status" aria-live="polite">
          {(query.length > 0 || isFilterBrowse) && !isFetching && isQuerySettled
            ? resultItems.length === 0
              ? t("No results found")
              : t("{{count}} results found", { count: resultItems.length })
            : ""}
        </VisuallyHidden>

        <Spotlight.ActionsList>
          {query.length === 0 &&
            !isFilterBrowse &&
            resultItems.length === 0 && (
              <Spotlight.Empty>
                {t("Start typing to search...")}
              </Spotlight.Empty>
            )}

          {(query.length > 0 || isFilterBrowse) &&
            !isFetching &&
            isQuerySettled &&
            resultItems.length === 0 && (
              <Spotlight.Empty>{t("No results found...")}</Spotlight.Empty>
            )}

          {resultItems.length > 0 && <>{resultItems}</>}

          {(query.length > 0 || isFilterBrowse) &&
            isFetching &&
            resultItems.length === 0 && (
              <Spotlight.Empty>
                <Text size="sm" style={{ marginTop: 10 }}>
                  {t("Searching...")}
                </Text>
              </Spotlight.Empty>
            )}
        </Spotlight.ActionsList>
      </Spotlight.Root>
    </>
  );
}
