import FeishuSettings from "@/pages/settings/platform/feishu-settings";
import AboutPlatform from "@/pages/settings/platform/about";
import KnowledgeConnect from '@/pages/auth/knowledge-connect';
import KnowledgeSettings from '@/pages/settings/platform/knowledge-settings';
import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "@/components/layouts/global/layout.tsx";
import { Error404 } from "@/components/ui/error-404.tsx";
import { isCloud } from "@/lib/config.ts";
import { useTranslation } from "react-i18next";
import { useRedirectToCloudSelect } from "@/platform/core-only";
import { useTrackOrigin } from "@/hooks/use-track-origin";


const LoginPage = lazy(() => import("@/pages/auth/login"));
const Home = lazy(() => import("@/pages/dashboard/home"));
const Page = lazy(() => import("@/pages/page/page"));
const AccountSettings = lazy(
  () => import("@/pages/settings/account/account-settings"),
);
const WorkspaceMembers = lazy(
  () => import("@/pages/settings/workspace/workspace-members"),
);
const WorkspaceSettings = lazy(
  () => import("@/pages/settings/workspace/workspace-settings"),
);
const Groups = lazy(() => import("@/pages/settings/group/groups"));
const GroupInfo = lazy(() => import("./pages/settings/group/group-info"));
const Spaces = lazy(() => import("@/pages/settings/space/spaces.tsx"));
const AccountPreferences = lazy(
  () => import("@/pages/settings/account/account-preferences.tsx"),
);
const SpaceFiles = lazy(() => import("@/pages/space/space-files.tsx"));
const SpaceHome = lazy(() => import("@/pages/space/space-home.tsx"));
const PageRedirect = lazy(() => import("@/pages/page/page-redirect.tsx"));
const SpacesPage = lazy(() => import("@/pages/spaces/spaces.tsx"));
const SpaceTrash = lazy(() => import("@/pages/space/space-trash.tsx"));
const FavoritesPage = lazy(() => import("@/pages/favorites/favorites-page"));
const LabelPage = lazy(() => import("@/pages/label/label-page"));

export default function App() {
  const { t } = useTranslation();
  useRedirectToCloudSelect();
  useTrackOrigin();

  useEffect(() => {
    // warm the editor chunk so opening a page doesn't wait on the network
    const timer = setTimeout(() => { void import("@/pages/page/page").catch(() => {}); }, 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Suspense fallback={null}>
      <Routes>
        <Route index element={<Navigate to="/home" />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/connect/knowledge" element={<KnowledgeConnect />} />
        <Route path="/p/:pageSlug" element={<PageRedirect />} />
        <Route element={<Layout />}>
          <Route path="/home" element={<Home />} />
          <Route path="/spaces" element={<SpacesPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/labels/:labelName" element={<LabelPage />} />
          <Route path="/s/:spaceSlug/files" element={<SpaceFiles />} />
          <Route path="/s/:spaceSlug" element={<SpaceHome />} />
          <Route path="/s/:spaceSlug/trash" element={<SpaceTrash />} />
          <Route path="/s/:spaceSlug/p/:pageSlug" element={<Page />} />
          <Route path="/settings">
            <Route path="account/profile" element={<AccountSettings />} />
            <Route path="account/preferences" element={<AccountPreferences />} />
            <Route path="workspace" element={<WorkspaceSettings />} />
            <Route path="members" element={<WorkspaceMembers />} />
            <Route path="groups" element={<Groups />} />
            <Route path="groups/:groupId" element={<GroupInfo />} />
            <Route path="spaces" element={<Spaces />} />
            <Route path="authentication" element={<FeishuSettings />} />
            <Route path="about" element={<AboutPlatform />} />
            <Route path="connections" element={<KnowledgeSettings />} />
          </Route>
        </Route>
        <Route path="*" element={<Error404 />} />
      </Routes>
    </Suspense>
  );
}
