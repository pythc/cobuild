import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import ProjectsPage from './pages/ProjectsPage/ProjectsPage';
import Layout from './components/Layout';
import { BrandMetadata } from './components/BrandMetadata';
import { LoadingState } from './components/WorkspaceStates';

const OperationsPage = lazy(
  () => import('./pages/OperationsPage/OperationsPage'),
);
const OperationsAdminsPage = lazy(
  () => import('./pages/OperationsAdminsPage/OperationsAdminsPage'),
);
const IterationsPage = lazy(
  () => import('./pages/IterationsPage/IterationsPage'),
);
const IterationSettingsPage = lazy(
  () => import('./pages/IterationSettingsPage/IterationSettingsPage'),
);
const NotFound = lazy(() => import('./pages/NotFound/NotFound'));
const RequirementDetailPage = lazy(
  () => import('./pages/RequirementDetailPage/RequirementDetailPage'),
);
const RequirementsPage = lazy(
  () => import('./pages/RequirementsPage/RequirementsPage'),
);
const PullRequestsPage = lazy(
  () => import('./pages/PullRequestsPage/PullRequestsPage'),
);
const NotificationsPage = lazy(
  () => import('./pages/NotificationsPage/NotificationsPage'),
);
const RequirementArchivePage = lazy(
  () => import('./pages/RequirementArchivePage/RequirementArchivePage'),
);
const WorkbenchPage = lazy(() => import('./pages/WorkbenchPage/WorkbenchPage'));

const LabConnectPage = lazy(() => import('./pages/LabConnectPage'));

const RelayPage = lazy(() => import('./pages/RelayPage/RelayPage'));

const RoutesComponent = () => {
  return (
    <Suspense fallback={<LoadingState />}>
      <BrandMetadata />
      <Routes>
        <Route path="relay" element={<RelayPage />} />
        <Route path="connect/110lab" element={<LabConnectPage />} />
        <Route element={<Layout />}>
          <Route index element={<WorkbenchPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="requirements" element={<RequirementsPage />} />
          <Route
            path="requirements/:recordId"
            element={<RequirementDetailPage />}
          />
          <Route
            path="board"
            element={<Navigate to="/requirements" replace />}
          />
          <Route path="iterations" element={<IterationsPage />} />
          <Route
            path="iterations/:iterationId/settings"
            element={<IterationSettingsPage />}
          />
          <Route path="pull-requests" element={<PullRequestsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="operations" element={<OperationsPage />} />
          <Route path="operations/admins" element={<OperationsAdminsPage />} />
          <Route path="archive" element={<RequirementArchivePage />} />
          <Route
            path="pull-requests/:pullNumber"
            element={<PullRequestsPage />}
          />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
};

export default RoutesComponent;
