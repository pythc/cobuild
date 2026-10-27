import ProjectActionsDialog from './ProjectActionsDialog';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowUpRight,
  CheckCircle2,
  Circle,
  FolderKanban,
  Plus,
  RefreshCw,
  Users,
  Flag,
} from 'lucide-react';
import type { ManagedProject } from '@shared/api.interface';
import { getProjectManagement } from '@/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '@/components/WorkspaceStates';
const PHASES: Record<string, string> = {
  exploring: '探索中',
  pending: '待审批',
  active: '已立项',
  needs_changes: '待修改',
  unconfigured: '待完善',
};
const COLORS: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700',
  pending: 'bg-amber-50 text-amber-700',
  needs_changes: 'bg-orange-50 text-orange-700',
  exploring: 'bg-blue-50 text-blue-700',
  unconfigured: 'bg-slate-100 text-slate-600',
};
export default function ProjectsPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const query = useQuery({
    queryKey: ['project-management'],
    queryFn: ({ signal }) => getProjectManagement(signal),
    refetchInterval: 30000,
  });
  const projects: ManagedProject[] = query.data?.projects || [];
  const selected: ManagedProject | undefined = projects.find(
    (p: ManagedProject) => p.projectId === params.get('project'),
  );
  const visible: ManagedProject[] = projects.filter(
    (p: ManagedProject) =>
      (filter === 'archived'
        ? p.snapshot?.archived
        : !p.snapshot?.archived &&
          (filter === 'all' || p.snapshot?.phase === filter)) &&
      (p.projectName + ' ' + p.projectSummary + ' ' + p.snapshot?.ownerName)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  if (query.isPending) return <LoadingState label="正在加载项目" />;
  if (query.isError && !query.data)
    return (
      <ErrorState
        message={query.error.message}
        onRetry={() => void query.refetch()}
      />
    );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-primary">
            110lab / Projects
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            项目管理
          </h1>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw
              className={`size-4 ${query.isFetching ? 'animate-spin' : ''}`}
            />
            刷新
          </Button>
          <Button asChild>
            <a
              href="https://internal.110-lab.cn/projects"
              target="_blank"
              rel="noreferrer"
            >
              <Plus className="size-4" />
              新建项目
            </a>
          </Button>
        </div>
      </div>
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          刷新失败，当前显示上次同步内容。
          <Button variant="ghost" onClick={() => void query.refetch()}>
            重试
          </Button>
        </p>
      ) : null}
      <div
        className="grid gap-3 sm:grid-cols-3"
        data-ai-section-type="card-stat"
      >
        {[
          [
            '全部项目',
            projects.filter((p: ManagedProject) => !p.snapshot?.archived)
              .length,
          ],
          [
            '已立项',
            projects.filter(
              (p: ManagedProject) =>
                !p.snapshot?.archived && p.snapshot?.phase === 'active',
            ).length,
          ],
          [
            '待审批',
            projects.filter(
              (p: ManagedProject) =>
                !p.snapshot?.archived && p.snapshot?.phase === 'pending',
            ).length,
          ],
        ].map(([label, count]) => (
          <div key={label} className="rounded-2xl border bg-card px-5 py-4">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{count}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1" aria-label="项目阶段">
          {[
            ['all', '全部'],
            ['active', '已立项'],
            ['exploring', '探索中'],
            ['pending', '待审批'],
            ['unconfigured', '待完善'],
            ['archived', '已归档'],
          ].map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? 'secondary' : 'ghost'}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <Input
          aria-label="搜索项目"
          placeholder="搜索项目、简介或负责人"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:max-w-72"
        />
      </div>
      <div
        className={`grid items-start gap-5 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]' : ''}`}
      >
        <div
          className={`grid gap-4 ${selected ? 'xl:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-3'}`}
          data-ai-section-type="card-list"
        >
          {visible.map((p: ManagedProject) => {
            const s = p.snapshot;
            const done =
              s?.milestones.filter((m) => m.status === 'done').length || 0;
            return (
              <button
                key={p.projectId}
                onClick={() => setParams({ project: p.projectId })}
                aria-pressed={selected?.projectId === p.projectId}
                className={`group flex min-h-52 flex-col gap-4 rounded-2xl border bg-card p-5 text-left transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md focus-visible:outline focus-visible:outline-primary ${selected?.projectId === p.projectId ? 'border-primary ring-1 ring-primary/20' : ''}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="rounded-xl bg-primary/8 p-2.5 text-primary">
                    <FolderKanban className="size-5" />
                  </span>
                  <Badge
                    variant="secondary"
                    className={COLORS[s?.phase || 'unconfigured']}
                  >
                    {s?.archived
                      ? '已归档'
                      : PHASES[s?.phase || 'unconfigured']}
                  </Badge>
                </div>
                <div className="flex-1">
                  <h2 className="break-words font-semibold">{p.projectName}</h2>
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
                    {p.projectSummary || '来自需求分类，尚未完善立项信息'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Users className="size-3.5" />
                    {s?.ownerName || '负责人待补充'}
                  </span>
                  <span>
                    {s?.milestones.length
                      ? `里程碑 ${done}/${s.milestones.length}`
                      : '暂无里程碑'}
                  </span>
                </div>
              </button>
            );
          })}
          {!visible.length ? (
            <div className="col-span-full">
              <EmptyState
                title="暂无匹配项目"
                description={
                  projects.length
                    ? '尝试调整搜索或筛选条件'
                    : '项目同步后会显示在这里'
                }
              />
            </div>
          ) : null}
        </div>
        {selected ? (
          <ProjectDetails key={selected.projectId} project={selected} onClose={() => setParams({})} />
        ) : null}
      </div>
    </div>
  );
}
function ProjectDetails({
  project: p,
  onClose,
}: {
  project: ManagedProject;
  onClose: () => void;
}) {
  const s = p.snapshot;
  const [manage,setManage]=useState(false);
  return (
    <aside className="space-y-5 rounded-2xl border bg-card p-5 lg:sticky lg:top-24">
      <div className="flex items-start justify-between gap-3">
        <h2 className="break-words text-lg font-semibold">{p.projectName}</h2>
        <Button size="sm" variant="ghost" onClick={onClose}>
          收起
        </Button>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-7 text-muted-foreground">
        {p.projectSummary || '待完善项目简介'}
      </p>
      <div className="grid gap-3 text-sm">
        <p>负责人：{s?.ownerName || '待补充'}</p>
        <p>成员：{s?.memberNames.join('、') || '暂无'}</p>
      </div>
      {s?.application ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">立项说明</h3>
          <p className="whitespace-pre-wrap break-words text-sm leading-7 text-muted-foreground">
            {s.application}
          </p>
        </section>
      ) : null}
      {s?.reviewNote ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">审批备注</h3>
          <p className="whitespace-pre-wrap break-words text-sm leading-7 text-muted-foreground">
            {s.reviewNote}
          </p>
        </section>
      ) : null}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Flag className="size-4" />
          里程碑
        </h3>
        <ul className="space-y-3">
          {s?.milestones.length ? (
            s.milestones.map((m) => (
              <li key={m.id} className="flex gap-2 text-sm">
                {m.status === 'done' ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                ) : (
                  <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <div>
                  <p className="break-words">{m.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {m.assigneeName}
                    {m.dueAt
                      ? ' · ' + new Date(m.dueAt).toLocaleDateString('zh-CN')
                      : ''}
                  </p>
                </div>
              </li>
            ))
          ) : (
            <li className="text-sm text-muted-foreground">暂无里程碑</li>
          )}
        </ul>
      </section>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={()=>setManage(true)}>管理里程碑与空间</Button>
        {manage?<ProjectActionsDialog projectId={p.projectId} onClose={()=>setManage(false)}/>:null}
        <Button asChild size="sm">
          <Link
            to={'/requirements?project=' + encodeURIComponent(p.projectName)}
          >
            查看需求
            <ArrowUpRight className="size-4" />
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <a href={p.sourceUrl} target="_blank" rel="noreferrer">
            {s?.phase === 'unconfigured' ? '完善立项' : '管理立项'}
            <ArrowUpRight className="size-4" />
          </a>
        </Button>
        {s
          ? [
              ['代码仓库', s.links.repository],
              ['文档', s.links.docs],
              ['WeKnow 空间', s.links.knowledgeSpace],
              ['演示', s.links.demo],
            ]
              .filter((entry): entry is [string,string] => typeof entry[1] === 'string' && !!entry[1])
              .map(([label, url]) => (
                <Button key={label} asChild size="sm" variant="ghost">
                  <a href={url} target="_blank" rel="noreferrer">
                    {label}
                    <ArrowUpRight className="size-4" />
                  </a>
                </Button>
              ))
          : null}
      </div>
      <p className="border-t pt-3 text-xs text-muted-foreground">
        同步于 {new Date(p.syncedAt).toLocaleString('zh-CN')}
      </p>
    </aside>
  );
}
