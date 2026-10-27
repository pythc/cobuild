import { BRAND_ICON_URL } from '@/lib/brand';
import { Brand } from '@/components/Brand';
import { CoBuildBrand } from './CoBuildBrand';
import { useCurrentUserProfile } from '@/hooks/use-selfhost-session';
import { lazy, Suspense, useState, useEffect, useRef } from 'react';
import { createContentMotion } from '@/styles/cobuild-motion/content-motion.mjs';
import type { ComponentType, FC } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { RequirementPlatformCapabilities } from '@shared/api.interface';
import {
  FolderKanban,
  BellRing,
  Archive,
  GitPullRequest,
  History,
  Layers3,
  ListTodo,
  Menu,
  Plus,
  UserRoundCheck,
} from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { UserDisplay } from '@/components/business-ui/user-display';
import OperationsRecovery from '@/components/OperationsRecovery';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { useCurrentPlatformUser } from '@/hooks/use-workspace';

const RelayWidget = lazy(() => import('./relay/RelayWidget'));

interface NavigationItem {
  label: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  requiredCapability?: keyof RequirementPlatformCapabilities;
}

const NAVIGATION: NavigationItem[] = [
  { label: '我的工作', path: '/', icon: UserRoundCheck, end: true },
  { label: '项目管理', path: '/projects', icon: FolderKanban },
  { label: '需求池', path: '/requirements', icon: ListTodo },
  { label: '迭代', path: '/iterations', icon: Layers3 },
  { label: '合并请求', path: '/pull-requests', icon: GitPullRequest },
  {
    label: '操作记录',
    path: '/operations',
    icon: History,
    requiredCapability: 'canViewOperations',
  },
  {
    label: '通知',
    path: '/notifications',
    icon: BellRing,
    requiredCapability: 'canViewNotifications',
  },
  {
    label: '归档',
    path: '/archive',
    icon: Archive,
    requiredCapability: 'canViewArchive',
  },
];

const Layout: FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const currentUser = useCurrentUserProfile();
  const platformUserQuery = useCurrentPlatformUser();
  const navigation: NavigationItem[] = NAVIGATION.filter(
    (item: NavigationItem): boolean =>
      !item.requiredCapability ||
      Boolean(platformUserQuery.data?.capabilities?.[item.requiredCapability]),
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const motion = createContentMotion();
    motion.enter(mainRef.current, location.pathname);
    return () => motion.dispose();
  }, [location.pathname]);

  const openCreateDialog = (): void => {
    if (location.pathname === '/requirements') {
      const params = new URLSearchParams(location.search);
      params.set('create', '1');
      navigate(`/requirements?${params.toString()}`);
      return;
    }
    const returnTo = `${location.pathname}${location.search}`;
    const params = new URLSearchParams({ create: '1' });
    params.set('returnTo', returnTo);
    navigate(`/requirements?${params.toString()}`);
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-transparent text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/75 bg-background/82 shadow-[0_1px_0_hsl(221_83%_53%_/_0.03)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1660px] items-center gap-2 px-3 py-2.5 sm:gap-4 sm:px-4 sm:py-3 lg:px-8">
          <CoBuildBrand>
            <NavLink
              to="/"
              aria-label="Makit 需求平台首页"
              className="flex items-center gap-2 rounded-md text-xl font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <img
                src={BRAND_ICON_URL}
                alt=""
                aria-hidden="true"
                width={26}
                height={26}
                className="size-[26px] shrink-0 object-contain"
              />
              <span>Makit</span>
            </NavLink>
          </CoBuildBrand>

          <nav className="hidden min-w-0 flex-1 items-center gap-1 xl:flex">
            {navigation.map((item: NavigationItem) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.end}
                  className={({ isActive }: { isActive: boolean }): string =>
                    cn(
                      'relative flex min-w-fit items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-200',
                      isActive
                        ? 'text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )
                  }
                >
                  {({ isActive }: { isActive: boolean }) => (
                    <>
                      {isActive ? (
                        <motion.span
                          layoutId={prefersReducedMotion ? undefined : 'workspace-active-navigation'}
                          className="absolute inset-0 rounded-lg border border-primary/10 bg-primary/10"
                          transition={{ duration: prefersReducedMotion ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                        />
                      ) : null}
                      <Icon className="relative z-10 size-4" />
                      <span className="relative z-10">{item.label}</span>
                    </>
                  )}
                </NavLink>
              );
            })}
          </nav>

          <div className="ml-auto flex min-w-fit items-center gap-2 sm:gap-3 xl:ml-0">
            <OperationsRecovery />
            {currentUser?.user_id ? (
              <div className="hidden max-w-36 2xl:block">
                <UserDisplay
                  value={[currentUser.user_id]}
                  size="small"
                  className="truncate"
                />
              </div>
            ) : null}
            <Button
              size="sm"
              onClick={openCreateDialog}
              disabled={
                platformUserQuery.isSuccess &&
                platformUserQuery.data?.capabilities?.canCreate === false
              }
              data-ai-section-type="button"
              aria-label="新建需求"
            >
              <Plus className="size-4" />
              <span className="hidden sm:inline">新建需求</span>
            </Button>
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8 xl:hidden"
                  aria-label="打开导航"
                >
                  <Menu className="size-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[min(86vw,340px)] p-0">
                <SheetHeader className="border-b px-5 py-5 text-left">
                  <SheetTitle>
                    <Brand className="flex items-center gap-3" />
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    平台导航
                  </SheetDescription>
                </SheetHeader>
                <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
                  {navigation.map((item: NavigationItem) => {
                    const Icon = item.icon;
                    return (
                      <NavLink
                        key={item.path}
                        to={item.path}
                        end={item.end}
                        onClick={() => setMobileMenuOpen(false)}
                        className={({ isActive }): string =>
                          cn(
                            'flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors',
                            isActive
                              ? 'bg-primary/10 text-primary'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                          )
                        }
                      >
                        <Icon className="size-4" />
                        <span>{item.label}</span>
                      </NavLink>
                    );
                  })}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <main
        key={location.pathname}
        ref={mainRef}
        className="mx-auto max-w-[1660px] px-3 py-4 sm:px-4 sm:py-5 lg:px-8 lg:py-7"
      >
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground" role="status">正在加载页面…</div>}>
          <Outlet />
        </Suspense>
      </main>
      <Suspense fallback={null}>
        <RelayWidget />
      </Suspense>
      <Toaster richColors closeButton />
    </div>
  );
};

export default Layout;
