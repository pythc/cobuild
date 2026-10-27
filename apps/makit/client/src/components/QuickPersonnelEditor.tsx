import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  PersonRef,
  RequirementPatch,
  RequirementPersonnelResponse,
  RequirementSummary,
} from '@shared/api.interface';
import { Check, LoaderCircle, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { getRequirementPersonnel } from '@/api';
import { UserSelect } from '@/components/business-ui/user-select';
import type { User } from '@/components/business-ui/types/user';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useUpdateRequirement } from '@/hooks/use-workspace';
import { errorMessage } from '@/lib/requirement-utils';
import {
  employeeUserIds,
  employeePersonRefs,
  employeeUsers,
  mergeEmployeeUsers,
  personnelUpdateInput,
} from '@/lib/personnel-users';
import PersonStack from './PersonStack';

export type PersonnelRole =
  | 'handlers'
  | 'productOwners'
  | 'developers'
  | 'testers'
  | 'foOwners'
  | 'proposers'
  | 'releaseOwners';

const ROLE_CONFIG: Record<
  PersonnelRole,
  { label: string; patchKey: keyof RequirementPatch }
> = {
  handlers: { label: '当前处理人', patchKey: 'handlerLarkUserIds' },
  productOwners: { label: '产品人员', patchKey: 'productOwnerLarkUserIds' },
  developers: { label: '研发人员', patchKey: 'developerLarkUserIds' },
  testers: { label: '测试人员', patchKey: 'testerLarkUserIds' },
  foOwners: { label: 'FO', patchKey: 'foOwnerLarkUserIds' },
  proposers: { label: '提出人', patchKey: 'proposerLarkUserIds' },
  releaseOwners: { label: '发布负责人', patchKey: 'releaseOwnerLarkUserIds' },
};

export default function QuickPersonnelEditor({
  requirementId,
  role,
  people,
  compact = false,
  editable = true,
}: {
  requirementId: string;
  role: PersonnelRole;
  people: PersonRef[];
  compact?: boolean;
  editable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [displayPeople, setDisplayPeople] = useState<PersonRef[]>(people);
  const initializedSnapshot = useRef('');
  const editSnapshot = useRef<RequirementPersonnelResponse | null>(null);
  const updateMutation = useUpdateRequirement();
  const config = ROLE_CONFIG[role];
  const personnelQuery = useQuery({
    queryKey: ['requirement-personnel', requirementId],
    queryFn: ({ signal }) => getRequirementPersonnel(requirementId, signal),
    enabled: open,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const roleIds: string[] = useMemo(
    () => personnelQuery.data?.personnelUserIds[role] || [],
    [personnelQuery.data, role],
  );
  const initialUsers = useMemo(
    () => employeeUsers(roleIds, people),
    [people, roleIds],
  );

  useEffect(() => setDisplayPeople(people), [people]);
  useEffect(() => {
    if (!open || !personnelQuery.data || personnelQuery.isFetching) return;
    const snapshot = `${role}:${String(personnelQuery.data.updatedAt)}`;
    // Background refetches must not overwrite a selection in progress.
    if (initializedSnapshot.current) return;
    initializedSnapshot.current = snapshot;
    editSnapshot.current = personnelQuery.data;
    setUsers(initialUsers);
  }, [
    initialUsers,
    open,
    personnelQuery.data,
    personnelQuery.isFetching,
    role,
  ]);

  const save = (): void => {
    const snapshot = editSnapshot.current;
    if (!snapshot || updateMutation.isPending) return;
    const previousPeople: PersonRef[] = displayPeople;
    const nextIds: string[] = employeeUserIds(users);
    const nextPeople: PersonRef[] = employeePersonRefs(users);
    const optimistic: Partial<RequirementSummary> = {
      [role]: nextPeople,
      personnelUserIds: {
        ...snapshot.personnelUserIds,
        [role]: nextIds,
      },
    };
    setDisplayPeople(nextPeople);
    void updateMutation
      .mutateAsync({
        recordId: requirementId,
        input: personnelUpdateInput(snapshot, role, users),
        optimistic,
      })
      .then((): void => {
        setOpen(false);
        toast.success('修改已提交');
      })
      .catch((error: unknown): void => {
        setDisplayPeople(previousPeople);
        toast.error(errorMessage(error));
      });
  };

  if (!editable) {
    return (
      <PersonStack people={displayPeople} max={compact ? 2 : 3} showNames />
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (updateMutation.isPending) return;
        if (nextOpen) {
          initializedSnapshot.current = '';
          editSnapshot.current = null;
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="group/person h-auto min-h-8 w-full justify-start gap-1.5 px-1.5 py-1 text-left"
          title={`点击快速更换${config.label}`}
        >
          <PersonStack people={displayPeople} max={compact ? 2 : 3} showNames />
          <Pencil className="ml-auto size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/person:opacity-100" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] space-y-3 sm:w-[360px]"
      >
        <div>
          <p className="text-sm font-medium">快速更换{config.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            可逐个添加或移除，保存后由协作工作流发送通知。
          </p>
        </div>
        {personnelQuery.isFetching && !editSnapshot.current ? (
          <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            正在读取最新成员
          </div>
        ) : personnelQuery.isError && !editSnapshot.current ? (
          <div className="rounded-md bg-destructive/5 p-3 text-sm text-destructive">
            {errorMessage(personnelQuery.error)}
          </div>
        ) : (
          <UserSelect
            disabled={updateMutation.isPending}
            multiple
            valueType="object"
            accountType="lark"
            value={users}
            onChange={(value) => setUsers(value || [])}
            onSelect={(selected) => {
              if (!selected.raw?.employee_id) return;
              setUsers((current) =>
                mergeEmployeeUsers(current, [selected.raw!]),
              );
            }}
            placeholder="搜索并选择成员"
            tagClosable
            className="w-full"
          />
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={updateMutation.isPending}
          >
            <X className="size-3.5" />
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={!editSnapshot.current || updateMutation.isPending}
          >
            <Check className="size-3.5" />
            {updateMutation.isPending ? '正在提交' : '保存'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
