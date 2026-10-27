import { useEffect, useMemo, useState } from 'react';
import type {
  RequirementPatch,
  RequirementSummary,
} from '@shared/api.interface';
import { Check, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import SingleIterationSelect from '@/components/SingleIterationSelect';
import { iterationAssignmentError } from '@shared/iteration-assignment';
import { Input } from '@/components/ui/input';
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
import { useUpdateRequirement } from '@/hooks/use-workspace';
import { errorMessage, formatDate } from '@/lib/requirement-utils';

type EditablePatchKey =
  | 'priority'
  | 'project'
  | 'type'
  | 'source'
  | 'effort'
  | 'gitBranchName'
  | 'githubPullRequestUrl'
  | 'iterationIds'
  | 'startAt'
  | 'developmentStartAt'
  | 'developmentEndAt'
  | 'testingAt'
  | 'deadlineAt';

type FieldValue = string | number | null | string[];

interface FieldOption {
  value: string;
  label: string;
}

function dateInputValue(value: FieldValue): string {
  if (value == null || value === '') return '';
  const date = new Date(Number(value) || String(value));
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateTimestamp(value: string): number | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00+08:00`).getTime();
}

export default function InlineRequirementFieldEditor({
  requirementId,
  expectedUpdatedAt,
  patchKey,
  value,
  kind = 'text',
  options = [],
  placeholder = '未设置',
  suffix = '',
  editable = true,
}: {
  requirementId: string;
  expectedUpdatedAt: string | number | null;
  patchKey: EditablePatchKey;
  value: FieldValue;
  kind?: 'text' | 'number' | 'date' | 'select' | 'iterations';
  options?: FieldOption[];
  placeholder?: string;
  suffix?: string;
  editable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FieldValue>(value);
  const [optimisticValue, setOptimisticValue] = useState<FieldValue>(value);
  const updateMutation = useUpdateRequirement();

  useEffect(() => {
    setDraft(value);
    setOptimisticValue(value);
  }, [value]);

  const labelByValue = useMemo(
    () => new Map(options.map((option) => [option.value, option.label])),
    [options],
  );

  const display = (): string => {
    if (kind === 'iterations') {
      const labels = (optimisticValue as string[])
        .map((id) => labelByValue.get(id) || '')
        .filter(Boolean);
      return labels.join('、') || placeholder;
    }
    if (kind === 'date')
      return formatDate(optimisticValue as string | number | null);
    if (kind === 'select') {
      return (
        labelByValue.get(String(optimisticValue || '')) ||
        String(optimisticValue || placeholder)
      );
    }
    if (optimisticValue == null || optimisticValue === '') return placeholder;
    return `${String(optimisticValue)}${suffix}`;
  };

  const normalizedDraft = (): FieldValue => {
    if (kind === 'number') {
      return draft === '' || draft == null ? null : Number(draft);
    }
    if (kind === 'date') return dateTimestamp(String(draft || ''));
    return draft;
  };

  const save = (): void => {
    const nextValue: FieldValue = normalizedDraft();
    const iterationError =
      kind === 'iterations' ? iterationAssignmentError(nextValue) : null;
    if (iterationError) {
      toast.error(iterationError);
      return;
    }
    const previousValue: FieldValue = optimisticValue;
    const patch = { [patchKey]: nextValue } as RequirementPatch;
    const optimistic: Partial<RequirementSummary> | undefined =
      kind === 'iterations'
        ? {
            iterationNames: (nextValue as string[])
              .map((id) => labelByValue.get(id) || '')
              .filter(Boolean),
          }
        : undefined;
    setOptimisticValue(nextValue);
    setOpen(false);
    toast.success('已修改');
    void updateMutation
      .mutateAsync({
        recordId: requirementId,
        input: { expectedUpdatedAt, patch },
        optimistic,
      })
      .catch((error: unknown): void => {
        setOptimisticValue(previousValue);
        toast.error(errorMessage(error));
      });
  };

  if (!editable) {
    return <span className="min-w-0 truncate px-2 py-1">{display()}</span>;
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setDraft(
            kind === 'date' ? dateInputValue(optimisticValue) : optimisticValue,
          );
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="group/inline h-auto min-h-8 w-full justify-start overflow-hidden px-2 py-1 text-left font-normal"
        >
          <span className="min-w-0 flex-1 truncate">{display()}</span>
          <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/inline:opacity-100" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[330px] space-y-3">
        {kind === 'select' ? (
          <Select
            value={String(draft || '__unset__')}
            onValueChange={(selected) =>
              setDraft(selected === '__unset__' ? '' : selected)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__unset__">未设置</SelectItem>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : kind === 'iterations' ? (
          <SingleIterationSelect
            value={draft as string[]}
            options={options}
            onChange={setDraft}
          />
        ) : (
          <Input
            type={
              kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'
            }
            min={kind === 'number' ? 0 : undefined}
            step={kind === 'number' ? '0.5' : undefined}
            value={draft == null ? '' : String(draft)}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            autoFocus
          />
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            <X className="size-3.5" />
            取消
          </Button>
          <Button type="button" size="sm" onClick={save}>
            <Check className="size-3.5" />
            保存
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
