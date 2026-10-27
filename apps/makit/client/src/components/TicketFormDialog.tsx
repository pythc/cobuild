import { useEffect, useRef, useState } from 'react';
import type {
  RequirementSummary,
  WorkspaceResponse,
} from '@shared/api.interface';
import { ticketPatchError } from '@shared/ticket-workflow';
import { prepareOperationInput } from '@shared/requirement-operation';
import { CalendarDays, LoaderCircle } from 'lucide-react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { toast } from 'sonner';
import { TiptapEditorComplete } from './business-ui/tiptap-editor';
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
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Textarea } from './ui/textarea';
import { Calendar } from './ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { useUpdateRequirement } from '@/hooks/use-workspace';
import {
  employeePersonRefs,
  employeeUserIds,
  mergeEmployeeUsers,
} from '@/lib/personnel-users';
import { errorMessage } from '@/lib/requirement-utils';
import { ticketEditInitialState, ticketEditPatch } from '@/lib/ticket-edit';

export default function TicketFormDialog({
  open,
  onOpenChange,
  requirement,
  workspace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requirement: RequirementSummary;
  workspace: Pick<WorkspaceResponse, 'iterations' | 'options'>;
}) {
  const [form, setForm] = useState(() => ticketEditInitialState(requirement));
  const [dateOpen, setDateOpen] = useState(false);
  const baseline = useRef({
    form: ticketEditInitialState(requirement),
    requirement,
  });
  const update = useUpdateRequirement();
  useEffect(() => {
    if (!open) return;
    const next = ticketEditInitialState(requirement);
    baseline.current = { form: next, requirement };
    setForm(next);
    // Preserve edits and the original revision while background data refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requirement.id]);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    if (!form.title.trim()) {
      toast.error('请填写工单标题');
      return;
    }
    const original = baseline.current;
    const patch = ticketEditPatch(original.requirement, original.form, form);
    if (!Object.keys(patch).length) {
      toast.info('没有实际变更');
      return;
    }
    const error = ticketPatchError(patch, original.requirement);
    if (error) {
      toast.error(error);
      return;
    }
    try {
      await update.mutateAsync({
        recordId: requirement.id,
        input: prepareOperationInput(original.requirement, {
          expectedUpdatedAt: original.requirement.updatedAt,
          patch,
        }),
        optimistic: {
          handlers: employeePersonRefs(form.handlers),
          personnelUserIds: {
            ...original.requirement.personnelUserIds,
            handlers: employeeUserIds(form.handlers),
          },
        },
      });
      toast.success('工单修改已提交');
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
      <DialogContent className="ticket-edit-dialog max-h-[92dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑工单</DialogTitle>
          <DialogDescription>{requirement.code}</DialogDescription>
        </DialogHeader>
        <fieldset disabled={update.isPending} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="ticket-title">工单标题 *</Label>
            <Input
              id="ticket-title"
              value={form.title}
              maxLength={500}
              onChange={(event) => set('title', event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>问题描述</Label>
            <TiptapEditorComplete
              value={form.introduction}
              onValueChange={(value) => set('introduction', value)}
              className="min-h-40 max-h-72 w-full"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>优先级</Label>
              <Select
                disabled={update.isPending}
                value={form.priority}
                onValueChange={(value) => set('priority', value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from(
                    new Set([form.priority, ...workspace.options.priorities]),
                  )
                    .filter(Boolean)
                    .map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>所属项目</Label>
              <Select
                disabled={update.isPending}
                value={form.project}
                onValueChange={(value) => set('project', value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from(
                    new Set([form.project, ...workspace.options.projects]),
                  )
                    .filter(Boolean)
                    .map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>当前处理人</Label>
              <UserSelect
                disabled={update.isPending}
                multiple
                valueType="object"
                accountType="lark"
                value={form.handlers}
                onChange={(next) => set('handlers', next || [])}
                onSelect={(selected) => {
                  if (selected.raw?.employee_id)
                    setForm((current) => ({
                      ...current,
                      handlers: mergeEmployeeUsers(current.handlers, [
                        selected.raw,
                      ]),
                    }));
                }}
                closeOnSelect
                tagClosable
                placeholder="选择处理人，可多选"
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ticket-deadline">截止时间</Label>
              <Popover open={dateOpen} onOpenChange={setDateOpen}>
                <PopoverTrigger asChild>
                  <Button id="ticket-deadline" type="button" variant="outline" className="w-full justify-start" disabled={update.isPending}>
                    <CalendarDays className="size-4" />{form.deadline || '未设置'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" locale={zhCN} selected={form.deadline ? new Date(`${form.deadline}T12:00:00`) : undefined} defaultMonth={form.deadline ? new Date(`${form.deadline}T12:00:00`) : undefined} onSelect={(date) => { set('deadline', date ? format(date, 'yyyy-MM-dd') : ''); setDateOpen(false); }} />
                  <Button type="button" variant="ghost" className="w-full" onClick={() => { set('deadline', ''); setDateOpen(false); }}>清除截止时间</Button>
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ticket-progress">处理进展</Label>
            <Textarea
              id="ticket-progress"
              value={form.latestProgress}
              onChange={(event) => set('latestProgress', event.target.value)}
              placeholder="记录进展、结论或需要补充的信息"
            />
          </div>
        </fieldset>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={update.isPending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button disabled={update.isPending} onClick={() => void submit()}>
            {update.isPending && (
              <LoaderCircle className="size-4 animate-spin" />
            )}
            保存变更
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
