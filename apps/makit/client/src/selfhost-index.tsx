import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RoutesComponent from './app';
import { useSelfhostSession } from './hooks/use-selfhost-session';
import { Button } from './components/ui/button';
import './index.css';

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 8000, retry: 1, refetchOnWindowFocus: false } } });
function SessionGate() {
  const session = useSelfhostSession();
  if (session.isPending) return <main className="grid min-h-screen place-items-center text-muted-foreground">正在连接…</main>;
  if (!session.data) return <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
    <section className="w-full max-w-sm rounded-2xl border bg-white p-8 shadow-sm">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Makit</h1>
      <Button className="w-full" asChild><a href={`/auth/start?${window.parent !== window ? 'embedded=1&' : ''}next=${encodeURIComponent(location.pathname + location.search)}`}>使用 CoBuild 登录</a></Button>
    </section>
  </main>;
  return <RoutesComponent />;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode>
  <BrowserRouter><QueryClientProvider client={client}>
    <ErrorBoundary fallbackRender={({ resetErrorBoundary }) => <main className="p-8">页面暂时无法打开 <Button onClick={resetErrorBoundary}>重试</Button></main>}>
      <SessionGate />
    </ErrorBoundary>
  </QueryClientProvider></BrowserRouter>
</React.StrictMode>);
