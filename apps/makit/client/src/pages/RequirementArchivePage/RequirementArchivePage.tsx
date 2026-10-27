import { useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import type { RequirementArchiveSummary } from '@shared/api.interface';
import {
  Archive,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingState } from '@/components/WorkspaceStates';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  usePermanentlyDeleteRequirement,
  useRequirementArchive,
  useRestoreRequirement,
} from '@/hooks/use-requirement-archive';
import { useCurrentPlatformUser } from '@/hooks/use-workspace';
import { errorMessage } from '@/lib/requirement-utils';
import { cn } from '@/lib/utils';

function formatDateTime(value: string): string {
  const parsed: Date = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

function PermanentDeleteAction({
  requirement,
  deleting,
  disabled,
  onDelete,
}: {
  requirement: RequirementArchiveSummary;
  deleting: boolean;
  disabled: boolean;
  onDelete: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const confirmationToken: string = requirement.code || requirement.title;
  const confirmed: boolean = confirmation.trim() === confirmationToken;
  const deletionInProgress: boolean = requirement.deletionStatus === 'deleting';

  const onOpenChange = (nextOpen: boolean): void => {
    if (!deleting) setOpen(nextOpen);
    if (!nextOpen) setConfirmation('');
  };

  const confirmDelete = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    if (!confirmed || deleting) return;
    void onDelete()
      .then((): void => {
        setOpen(false);
        setConfirmation('');
      })
      .catch((): void => undefined);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button
          variant="destructive"
          size="sm"
          disabled={disabled || deletionInProgress}
        >
          <Trash2 className="size-4" />
          {requirement.deletionStatus === 'failed' ? '继续删除' : '永久删除'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>永久删除“{requirement.title}”？</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              该操作不可撤销，将删除需求及其评论、验收项、关联关系和协作记录。
            </span>
            <span className="block">
              请输入 <strong>{confirmationToken}</strong> 完成二次确认。
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={confirmationToken}
          autoComplete="off"
          aria-label="永久删除确认内容"
          disabled={deleting}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={!confirmed || deleting}
            onClick={confirmDelete}
          >
            {deleting ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            确认永久删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function RequirementArchivePage() {
  const [search, setSearch] = useState('');
  const currentUser = useCurrentPlatformUser();
  const canViewArchive: boolean = Boolean(
    currentUser.data?.capabilities?.canViewArchive,
  );
  const canPermanentlyDelete: boolean = Boolean(
    currentUser.data?.capabilities?.canPermanentlyDelete,
  );
  const archive = useRequirementArchive(canViewArchive);
  const restore = useRestoreRequirement();
  const permanentlyDelete = usePermanentlyDeleteRequirement();

  const filteredItems: RequirementArchiveSummary[] = useMemo(() => {
    const keyword: string = search.trim().toLowerCase();
    const items: RequirementArchiveSummary[] = archive.data?.items || [];
    if (!keyword) return items;
    return items.filter((item: RequirementArchiveSummary): boolean =>
      [item.code, item.title, item.archivedByName].some((value: string) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }, [archive.data?.items, search]);

  const restoreItem = async (
    requirement: RequirementArchiveSummary,
  ): Promise<void> => {
    try {
      const result = await restore.mutateAsync(requirement.requirementId);
      toast.success(result.message);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const deleteItem = async (
    requirement: RequirementArchiveSummary,
  ): Promise<void> => {
    try {
      const result = await permanentlyDelete.mutateAsync(
        requirement.requirementId,
      );
      toast.success(result.message);
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  };

  if (currentUser.isLoading) {
    return <LoadingState label="正在核验管理员权限" />;
  }
  if (currentUser.isError || !currentUser.data) {
    return (
      <ErrorState
        message={currentUser.error?.message || '获取当前平台用户失败'}
        onRetry={() => void currentUser.refetch()}
      />
    );
  }
  if (!canViewArchive) {
    return (
      <Card className="mx-auto max-w-xl border-amber-200 bg-amber-50 shadow-none">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <ShieldAlert className="size-8 text-amber-700" />
          <div>
            <h1 className="text-lg font-semibold">当前账号无权访问需求归档</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              归档恢复和永久删除属于管理操作，请联系平台管理员处理。
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (archive.isError) {
    return (
      <ErrorState
        message={archive.error?.message || '获取需求归档失败'}
        onRetry={() => void archive.refetch()}
      />
    );
  }
  if (archive.isLoading || !archive.data) {
    return <LoadingState label="正在加载需求归档" />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">需求归档</h1>
            <Badge variant="secondary">{archive.data.items.length} 项</Badge>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => void archive.refetch()}
          disabled={archive.isFetching}
        >
          <RefreshCw
            className={cn('size-4', archive.isFetching && 'animate-spin')}
          />
          刷新
        </Button>
      </div>

      <Card className="overflow-hidden rounded-lg shadow-none">
        <div className="border-b p-3">
          <div className="relative max-w-xl">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索需求编号、标题或归档人"
              className="pl-9"
            />
          </div>
        </div>

        {filteredItems.length ? (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>需求</TableHead>
                    <TableHead className="w-[180px]">归档人</TableHead>
                    <TableHead className="w-[210px]">归档时间</TableHead>
                    <TableHead className="w-[230px] text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map((item: RequirementArchiveSummary) => (
                    <TableRow key={item.requirementId}>
                      <TableCell>
                        <p className="font-medium">{item.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.code || '未设置需求编号'}
                        </p>
                      </TableCell>
                      <TableCell>{item.archivedByName || '未知用户'}</TableCell>
                      <TableCell className="tabular-nums">
                        {formatDateTime(item.archivedAt)}
                        {item.deletionStatus === 'failed' ? (
                          <p className="mt-1 text-xs text-destructive">
                            删除未完成，可安全重试
                          </p>
                        ) : item.deletionStatus === 'deleting' ? (
                          <p className="mt-1 text-xs text-amber-700">
                            正在永久删除
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              item.deletionStatus !== 'idle' ||
                              restore.isPending ||
                              permanentlyDelete.isPending
                            }
                            onClick={() => void restoreItem(item)}
                          >
                            {restore.isPending &&
                            restore.variables === item.requirementId ? (
                              <LoaderCircle className="size-4 animate-spin" />
                            ) : (
                              <RotateCcw className="size-4" />
                            )}
                            恢复
                          </Button>
                          <PermanentDeleteAction
                            requirement={item}
                            disabled={
                              !canPermanentlyDelete ||
                              restore.isPending ||
                              permanentlyDelete.isPending
                            }
                            deleting={
                              permanentlyDelete.isPending &&
                              permanentlyDelete.variables === item.requirementId
                            }
                            onDelete={() => deleteItem(item)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="divide-y md:hidden">
              {filteredItems.map((item: RequirementArchiveSummary) => (
                <div key={item.requirementId} className="space-y-4 p-4">
                  <div>
                    <p className="font-medium">{item.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.code || '未设置需求编号'}
                    </p>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    <p>由 {item.archivedByName || '未知用户'} 归档</p>
                    <p className="mt-1 tabular-nums">
                      {formatDateTime(item.archivedAt)}
                    </p>
                    {item.deletionStatus === 'failed' ? (
                      <p className="mt-1 text-xs text-destructive">
                        删除未完成，可安全重试
                      </p>
                    ) : item.deletionStatus === 'deleting' ? (
                      <p className="mt-1 text-xs text-amber-700">
                        正在永久删除
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        item.deletionStatus !== 'idle' ||
                        restore.isPending ||
                        permanentlyDelete.isPending
                      }
                      onClick={() => void restoreItem(item)}
                    >
                      {restore.isPending &&
                      restore.variables === item.requirementId ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <RotateCcw className="size-4" />
                      )}
                      恢复
                    </Button>
                    <PermanentDeleteAction
                      requirement={item}
                      disabled={
                        !canPermanentlyDelete ||
                        restore.isPending ||
                        permanentlyDelete.isPending
                      }
                      deleting={
                        permanentlyDelete.isPending &&
                        permanentlyDelete.variables === item.requirementId
                      }
                      onDelete={() => deleteItem(item)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <CardContent className="p-4">
            <EmptyState
              title={archive.data.items.length ? '没有匹配的归档需求' : '归档为空'}
              description={
                archive.data.items.length
                  ? '请调整搜索关键词。'
                  : '归档后的需求会显示在这里，并可随时恢复。'
              }
            />
          </CardContent>
        )}
      </Card>

      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <Archive className="mt-0.5 size-4 shrink-0" />
        <p>
          恢复会让需求重新出现在需求池中；永久删除会清理需求及关联数据，且无法恢复。
        </p>
      </div>
    </div>
  );
}
