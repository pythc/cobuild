import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentUserProfile } from '@/hooks/use-selfhost-session';
import type {
  SavedViewConfig,
  WorkspaceSavedView,
  WorkspaceSavedViewInput,
} from '@shared/workspace-efficiency';
import {
  BookmarkPlus,
  LoaderCircle,
  Pencil,
  Trash2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { workspaceEfficiencyApi } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { legacySavedViewConfig } from '@/lib/saved-view-query';

export default function WorkspaceSavedViews({
  config,
  onSelect,
  legacyOwner,
}: {
  config: SavedViewConfig;
  onSelect: (config: SavedViewConfig) => void;
  legacyOwner?: { miaodaUserId: string; employeeId: string };
}) {
  const userId = useCurrentUserProfile().user_id;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'personal' | 'team'>('personal');
  const [editing, setEditing] = useState<WorkspaceSavedView | null>(null);
  const key = ['workspace-views', userId] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => workspaceEfficiencyApi.getViews(signal),
    enabled: Boolean(userId) && open,
    staleTime: 30_000,
  });
  const data = userId && query.data?.userId === userId ? query.data : undefined;
  const legacy = useMemo((): Array<{
    name: string;
    config: SavedViewConfig;
  }> => {
    if (!open || !userId || legacyOwner?.miaodaUserId !== userId) return [];
    try {
      const raw: unknown = JSON.parse(
        localStorage.getItem(
          `requirements:saved-views:v1:${legacyOwner.employeeId || userId}`,
        ) || '[]',
      );
      if (!Array.isArray(raw)) return [];
      return raw
        .flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return [];
          const value = item as { name?: unknown; query?: unknown };
          if (typeof value.name !== 'string' || typeof value.query !== 'string')
            return [];
          const converted = legacySavedViewConfig(value.query);
          return converted
            ? [{ name: value.name.slice(0, 120), config: converted }]
            : [];
        })
        .filter(
          (item) =>
            !data?.items.some(
              (view) => view.scope === 'personal' && view.name === item.name,
            ),
        )
        .slice(0, 100);
    } catch {
      return [];
    }
  }, [open, userId, legacyOwner?.miaodaUserId, legacyOwner?.employeeId, data]);
  const importLegacy = useMutation({
    mutationFn: async () => {
      for (const view of legacy)
        await workspaceEfficiencyApi.saveView({ ...view, scope: 'personal' });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onSuccess: () => toast.success('本机视图已同步'),
    onError: (error: Error) => toast.error(error.message),
  });
  const save = useMutation({
    mutationFn: (input: WorkspaceSavedViewInput) =>
      workspaceEfficiencyApi.saveView(input, editing?.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      setName('');
      setEditing(null);
      toast.success('视图已保存');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (view: WorkspaceSavedView) =>
      workspaceEfficiencyApi.deleteView(view.id, view.version),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success('视图已删除');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const submit = () =>
    save.mutate({
      name,
      scope: editing?.scope || scope,
      config,
      ...(editing ? { expectedVersion: editing.version } : {}),
    });
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) {
          setEditing(null);
          setName('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <BookmarkPlus className="size-4" />
          保存视图
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(360px,calc(100vw-32px))] space-y-4 p-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">筛选视图</h2>
          <Badge variant="secondary">跨设备同步</Badge>
        </div>
        {query.isError ? (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {query.error.message}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void query.refetch()}
            >
              重试
            </Button>
          </div>
        ) : !data ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            读取视图
          </div>
        ) : (
          <>
            {legacy.length ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => importLegacy.mutate()}
                disabled={importLegacy.isPending}
              >
                同步本机已有的 {legacy.length} 个视图
              </Button>
            ) : null}
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {!data.items.length ? (
                <p className="py-3 text-sm text-muted-foreground">
                  还没有保存视图
                </p>
              ) : (
                data.items.map((view) => (
                  <div
                    key={view.id}
                    className="group flex items-center gap-1 rounded-lg hover:bg-muted/50"
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-w-0 flex-1 justify-start"
                      onClick={() => {
                        onSelect(view.config);
                        setOpen(false);
                      }}
                    >
                      {view.scope === 'team' ? (
                        <Users className="size-3.5 text-primary" />
                      ) : null}
                      <span className="truncate">{view.name}</span>
                    </Button>
                    {view.canEdit ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`更新视图：${view.name}`}
                          onClick={() => {
                            setEditing(view);
                            setName(view.name);
                          }}
                        >
                          <Pencil className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:text-destructive"
                          aria-label={`删除视图：${view.name}`}
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(view)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </>
                    ) : null}
                  </div>
                ))
              )}
            </div>
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs text-muted-foreground">
                {editing
                  ? `用当前筛选更新「${editing.name}」`
                  : '将当前筛选、排序和列宽保存为视图'}
              </p>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：本迭代待测试"
                maxLength={120}
              />
              <div className="flex items-center justify-between gap-2">
                {data.canManageTeamViews && !editing ? (
                  <Select
                    value={scope}
                    onValueChange={(value) =>
                      setScope(value as 'personal' | 'team')
                    }
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">个人视图</SelectItem>
                      <SelectItem value="team">团队视图</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {editing?.scope === 'team' ? '团队视图' : '仅自己可见'}
                  </span>
                )}
                <div className="flex gap-1">
                  {editing ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(null);
                        setName('');
                      }}
                    >
                      取消
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={submit}
                    disabled={!name.trim() || save.isPending}
                  >
                    {save.isPending ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : null}
                    保存
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
