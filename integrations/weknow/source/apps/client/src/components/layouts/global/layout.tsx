import { UserProvider } from "@/features/user/user-provider.tsx";
import { Outlet, useParams } from "react-router-dom";
import GlobalAppShell from "@/components/layouts/global/global-app-shell.tsx";
import { PosthogUser } from "@/platform/core-only";
import { isCloud } from "@/lib/config.ts";
import { SearchSpotlight } from "@/features/search/components/search-spotlight.tsx";
import React from "react";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { spaceSearchSpotlightStore } from "@/features/search/constants";

import { useContentMotion } from "@/styles/cobuild-motion/use-content-motion";

export default function Layout() {
  useContentMotion();
  const { spaceSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);

  return (
    <UserProvider>
      <GlobalAppShell>
        <Outlet />
      </GlobalAppShell>
      {isCloud() && <PosthogUser />}
      <SearchSpotlight />
      {space?.id && (
        <SearchSpotlight
          key={space.id}
          spaceId={space.id}
          store={spaceSearchSpotlightStore}
        />
      )}
    </UserProvider>
  );
}
