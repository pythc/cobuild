import { useEffect, useRef, useState } from 'react';
import {
  ticketAllowedStatuses,
  ticketPatchError,
} from '@shared/ticket-workflow';
import type { RequirementPatch } from '@shared/api.interface';
import { prepareOperationInput } from '@shared/requirement-operation';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { StatusTransitionProps } from './ConfiguredStatusTransitionDialog';
import { UserSelect } from './business-ui/user-select';
import type { User } from './business-ui/types/user';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { useUpdateRequirement } from '@/hooks/use-workspace';
import {
  employeePersonRefs,
  employeeUserIds,
  employeeUsers,
  mergeEmployeeUsers,
} from '@/lib/personnel-users';
import { errorMessage } from '@/lib/requirement-utils';

export default function TicketStatusTransitionDialog({
  open,
  onOpenChange,
  requirement,
  initialTarget,
}: StatusTransitionProps) {
  const targets = ticketAllowedStatuses(requirement.status).filter(
    (status) =>
      status !== requirement.status &&
      requirement.allowedStatuses.includes(status),
  );
  const [target, setTarget] = useState('');
  const [handlers, setHandlers] = useState<User[]>([]);
  const [note, setNote] = useState('');
  const baseline = useRef(requirement);
  const update = useUpdateRequirement();
  // Initialize once per opening; polling must not overwrite a draft in this dialog.
  useEffect(() => {
    if (!open) return;
    baseline.current = requirement;
    setTarget(
      initialTarget && targets.includes(initialTarget)
        ? initialTarget
        : targets[0] || '',
    );
    setHandlers(
      employeeUsers(
        requirement.personnelUserIds.handlers,
        requirement.handlers,
      ),
    );
    setNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requirement.id]);
  const needsResult = ['已解决', '已关闭'].includes(target);
  const submit = async () => {
    if (!targets.includes(target)) return;
    const selected = target === '待分派' ? [] : handlers;
    const patch: RequirementPatch = {
      status: target,
      handlerLarkUserIds: employeeUserIds(selected),
      ...(note.trim() ? { latestProgress: note.trim() } : {}),
    };
    const error = ticketPatchError(patch, baseline.current);
    if (error) {
      toast.error(error);
      return;
    }
    try {
      await update.mutateAsync({
        recordId: requirement.id,
        input: prepareOperationInput(baseline.current, {
          expectedUpdatedAt: baseline.current.updatedAt,
          intent: 'status-transition',
          patch,
        }),
        optimistic: {
          handlers: employeePersonRefs(selected),
          personnelUserIds: {
            ...requirement.personnelUserIds,
            handlers: employeeUserIds(selected),
          },
        },
      });
      toast.success('状态修改已提交');
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!update.isPending) onOpenChange(value);
      }}
    >
      <DialogContent className="ticket-edit-dialog max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>更新工单状态</DialogTitle>
          <DialogDescription>当前：{requirement.status}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="目标状态"
          >
            {targets.map((status) => (
              <Button
                key={status}
                type="button"
                variant={target === status ? 'default' : 'outline'}
                aria-pressed={target === status}
                disabled={update.isPending}
                onClick={() => setTarget(status)}
              >
                {status}
              </Button>
            ))}
            {!targets.length && (
              <p className="text-sm text-muted-foreground">
                暂无可用的工单状态，请刷新后重试。
              </p>
            )}
          </div>
          {target && target !== '待分派' && (
            <div className="space-y-2">
              <Label>当前处理人{target === '已关闭' ? '（可选）' : ' *'}</Label>
              <UserSelect
                disabled={update.isPending}
                multiple
                valueType="object"
                accountType="lark"
                value={handlers}
                onChange={(next) => setHandlers(next || [])}
                onSelect={(selected) => {
                  if (selected.raw?.employee_id)
                    setHandlers((current) =>
                      mergeEmployeeUsers(current, [selected.raw]),
                    );
                }}
                closeOnSelect
                tagClosable
                placeholder="选择处理人，可多选"
                className="w-full"
              />
            </div>
          )}
          {target === '待分派' && (
            <p className="text-sm text-muted-foreground">
              转为待分派后将清空当前处理人。
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="ticket-transition-result">
              处理说明{needsResult ? ' *' : '（可选）'}
            </Label>
            <Textarea
              id="ticket-transition-result"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                needsResult ? '说明处理结果或关闭原因' : '补充当前进展'
              }
              disabled={update.isPending}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={update.isPending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            disabled={!target || update.isPending}
            onClick={() => void submit()}
          >
            {update.isPending && (
              <LoaderCircle className="size-4 animate-spin" />
            )}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
