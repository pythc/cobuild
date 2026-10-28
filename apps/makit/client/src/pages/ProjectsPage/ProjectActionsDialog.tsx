import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { LiveProject, ProjectAction } from '@shared/project-actions';
import { projectAction } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
} from '@/components/ui/dialog';
import { ErrorState, LoadingState } from '@/components/WorkspaceStates';

export default function ProjectActionsDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const key = ['live-kick-project', projectId];
  const [url, setUrl] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const query = useQuery<LiveProject>({
    queryKey: key,
    queryFn: () =>
      projectAction({
        projectId,
        action: 'read',
        requestId: crypto.randomUUID(),
      }),
    retry: 1,
  });
  const mutation = useMutation({
    mutationFn: ({
      action,
      input,
    }: {
      action: ProjectAction;
      input: Record<string, unknown>;
    }) => {
      const fingerprint = JSON.stringify([projectId, action, input]);
      if (request.current?.fingerprint !== fingerprint)
        request.current = { fingerprint, id: crypto.randomUUID() };
      return projectAction({
        projectId,
        action,
        input,
        requestId: request.current.id,
      });
    },
    onSuccess: (project: LiveProject, variables) => {
      request.current = null;
      cache.setQueryData(key, project);
      void cache.invalidateQueries({ queryKey: ['project-management'] });
      if (variables.action === 'milestone_add') {
        setTitle('');
        setDue('');
      }
      if (variables.action === 'knowledge_link') setUrl(null);
    },
    retry: false,
  });
  const p = query.data;
  const people = p
    ? [{ subject: p.ownerSubject, name: p.ownerName }, ...p.members]
    : [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={!mutation.isPending}
        className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>{p?.name || '项目管理'}</DialogTitle>
        </DialogHeader>
        {query.isPending ? <LoadingState label="正在核对项目和权限" /> : null}
        {query.isError ? (
          <ErrorState
            message={query.error.message}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {mutation.isError ? (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {mutation.error.message}
            。可重试相同内容；若提示版本冲突，请刷新后核对。
          </p>
        ) : null}
        {p ? (
          <div className="space-y-6">
            <section className="space-y-3">
              <h3 className="font-semibold">WeKnow 项目空间</h3>
              {p.links.knowledgeSpace ? (
                <a
                  href={p.links.knowledgeSpace}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block break-all text-primary underline"
                >
                  打开项目空间
                </a>
              ) : (
                <p className="text-sm text-muted-foreground">尚未关联空间</p>
              )}
              {p.canEdit ? (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    mutation.mutate({
                      action: 'knowledge_link',
                      input: {
                        revision: p.revision,
                        url: url ?? p.links.knowledgeSpace ?? '',
                      },
                    });
                  }}
                >
                  <Input
                    aria-label="WeKnow 空间链接"
                    type="url"
                    placeholder="https://knowledge.110-lab.cn/s/..."
                    value={url ?? p.links.knowledgeSpace ?? ''}
                    onChange={(event) => setUrl(event.target.value)}
                    maxLength={2000}
                  />
                  <Button disabled={mutation.isPending}>保存链接</Button>
                </form>
              ) : null}
            </section>
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">里程碑</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={query.isFetching || mutation.isPending}
                  onClick={() => void query.refetch()}
                >
                  刷新
                </Button>
              </div>
              {!p.milestones.length ? (
                <p className="text-sm text-muted-foreground">暂无里程碑</p>
              ) : (
                <ul className="divide-y rounded-xl border">
                  {p.milestones.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center justify-between gap-3 p-3"
                    >
                      <div className="min-w-0">
                        <p
                          className={
                            m.status === 'done'
                              ? 'break-words text-muted-foreground line-through'
                              : 'break-words'
                          }
                        >
                          {m.title}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {people.find(
                            (person) => person.subject === m.assignee,
                          )?.name || '成员'}
                          {m.dueAt
                            ? ' · ' +
                              new Date(m.dueAt).toLocaleDateString('zh-CN')
                            : ''}
                        </p>
                      </div>
                      {m.canChange ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={mutation.isPending}
                          onClick={() =>
                            mutation.mutate({
                              action: 'milestone_set',
                              input: {
                                id: m.id,
                                revision: m.revision,
                                status: m.status === 'done' ? 'open' : 'done',
                              },
                            })
                          }
                        >
                          {m.status === 'done' ? '重新打开' : '标记完成'}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {m.status === 'done' ? '已完成' : '进行中'}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {p.canEdit ? (
                <form
                  className="space-y-3 rounded-xl border p-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    mutation.mutate({
                      action: 'milestone_add',
                      input: {
                        title,
                        assignee: assignee || p.ownerSubject,
                        dueAt: due
                          ? new Date(due + 'T23:59:59').toISOString()
                          : null,
                      },
                    });
                  }}
                >
                  <h4 className="text-sm font-medium">新建里程碑</h4>
                  <Input
                    aria-label="里程碑名称"
                    placeholder="里程碑名称"
                    required
                    value={title}
                    maxLength={160}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      负责人
                      <select
                        className="h-10 w-full rounded-md border bg-background px-3"
                        value={assignee || p.ownerSubject}
                        onChange={(e) => setAssignee(e.target.value)}
                      >
                        {people.map((person) => (
                          <option key={person.subject} value={person.subject}>
                            {person.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-sm">
                      截止日期
                      <Input
                        aria-label="截止日期"
                        type="date"
                        value={due}
                        onChange={(e) => setDue(e.target.value)}
                      />
                    </label>
                  </div>
                  <Button disabled={mutation.isPending || !title.trim()}>
                    添加里程碑
                  </Button>
                </form>
              ) : null}
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
