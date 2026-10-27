import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AppContainer } from '@lark-apaas/client-toolkit/components/AppContainer';
import { ErrorRender } from '@lark-apaas/client-toolkit/components/ErrorRender';

import RoutesComponent from './app.tsx';
import './index.css';

const CLIENT_BASE_PATH = process.env.CLIENT_BASE_PATH || '/';
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 8_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const MainApp = () => {
  return (
    <BrowserRouter basename={CLIENT_BASE_PATH}>
      <AppContainer defaultTheme="light">
        <ErrorBoundary
          fallbackRender={({ error, resetErrorBoundary }) => (
            <ErrorRender
              error={error as Error}
              resetErrorBoundary={resetErrorBoundary}
            />
          )}
        >
          <QueryClientProvider client={queryClient}>
            <RoutesComponent />
          </QueryClientProvider>
        </ErrorBoundary>
      </AppContainer>
    </BrowserRouter>
  );
};

createRoot(document.getElementById('root')!).render(<MainApp />);
