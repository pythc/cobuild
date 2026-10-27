import { useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Table, type TableProps } from '@lark-apaas/client-toolkit/antd-table';
import {
  Building,
  Globe,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type {
  ForceRoleDTO,
  OperationsRoleMemberInput,
} from '@shared/api.interface';
import { operationsApi } from '@/api';
import { LoadingState } from '@/components/WorkspaceStates';
import {
  OPERATIONS_QUERY_KEY,
  useOperationsAccess,
} from '@/hooks/use-operations';
import { UserSelect } from '@/components/business-ui/user-select';
import { UserSelectTag } from '@/components/business-ui/user-select/user-select-tag';
import { DepartmentSelectTag } from '@/components/business-ui/department-select/department-select-tag';
import { ChatSelectTag } from '@/components/business-ui/chat-select/chat-select-tag';
import { ItemPill } from '@/components/business-ui/entity-combobox/item-pill';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const SUPER_ROLE: string = 'operations_super_admin';
const VIEWER_ROLE: string = 'operations_viewer';
type RoleMembers = NonNullable<ForceRoleDTO['roleMembers']>;
type RoleUser = NonNullable<RoleMembers['userList']>[number];

const memberName = (member: RoleUser): string =>
  member.name?.zh_cn || member.name?.en_us || '平台成员';
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : '操作失败，请稍后重试';

const MemberSummary: FC<{ role: ForceRoleDTO }> = ({ role }) => {
  const members: RoleMembers = role.roleMembers || {};
  const pills = [
    ...(members.userList || []).map((user: RoleUser, index: number) => (
      <UserSelectTag
        key={`user-${user.userID || index}`}
        userValue={{
          id: user.userID || '',
          name: memberName(user),
          avatar: user.avatar,
        }}
        onClose={() => undefined}
        disabled
        className="!cursor-default !opacity-100"
        size="small"
      />
    )),
    ...(members.departmentList || []).map((department, index: number) => (
      <DepartmentSelectTag
        key={`department-${department.id || index}`}
        departmentValue={{
          id: department.id || '',
          name: department.name?.zh_cn || '部门',
        }}
        onClose={() => undefined}
        disabled
        className="!cursor-default !opacity-100"
        size="small"
      />
    )),
    ...(members.groupChatList || []).map((chat, index: number) => (
      <ChatSelectTag
        key={`chat-${chat.chatID || index}`}
        chatValue={{
          id: chat.chatID || '',
          name: chat.name?.zh_cn || '群组',
          avatar: chat.avatar || '#1456F0',
        }}
        onClose={() => undefined}
        disabled
        className="!cursor-default !opacity-100"
        size="small"
      />
    )),
  ];
  const special = [
    ...(members.allEmployees ? [{ label: '企业全员', Icon: Building }] : []),
    ...(members.public ? [{ label: '互联网公开', Icon: Globe }] : []),
    ...(members.presetGroup?.isContainsAdmin
      ? [{ label: '应用开发者', Icon: Users }]
      : []),
  ];
  if (!pills.length && !special.length)
    return <span className="text-muted-foreground">暂无成员</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {special.map(({ label, Icon }) => (
        <ItemPill
          key={label}
          label={label}
          size="small"
          avatarFallback={false}
          avatar={
            <span className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
              <Icon className="size-3" />
            </span>
          }
        />
      ))}
      {pills.slice(0, 3)}
      {pills.length > 3 && (
        <HoverCard openDelay={200} closeDelay={100}>
          <HoverCardTrigger asChild>
            <Badge variant="outline" tabIndex={0}>
              +{pills.length - 3}
            </Badge>
          </HoverCardTrigger>
          <HoverCardContent className="w-auto max-w-[360px] p-3">
            <div className="flex flex-wrap gap-1.5">{pills.slice(3)}</div>
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  );
};

const OperationsAdminsPage: FC = () => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<boolean>(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RoleUser | null>(null);
  const access = useOperationsAccess();
  const roles = useQuery({
    queryKey: [...OPERATIONS_QUERY_KEY, 'roles', access.data?.userId],
    queryFn: ({ signal }) => operationsApi.getRoles(signal),
    enabled: access.data?.canManageAdmins === true && !access.isError,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (input: OperationsRoleMemberInput) =>
      operationsApi.changeMember(input),
    onSuccess: async (_result, input: OperationsRoleMemberInput) => {
      setSelectedUserId(null);
      setRemoving(null);
      toast.success(input.action === 'add' ? '已授权' : '已撤销');
      await queryClient.invalidateQueries({
        queryKey: [...OPERATIONS_QUERY_KEY, 'roles'],
      });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({
        queryKey: [...OPERATIONS_QUERY_KEY, 'access'],
      });
    },
  });
  const viewerRole: ForceRoleDTO | undefined = roles.data?.find(
    (role: ForceRoleDTO): boolean => role.bizID === VIEWER_ROLE,
  );
  const viewerUsers: RoleUser[] = viewerRole?.roleMembers?.userList || [];
  const alreadyAdded: boolean = viewerUsers.some(
    (user: RoleUser): boolean => user.userID === selectedUserId,
  );
  const columns: TableProps<ForceRoleDTO>['columns'] = [
    {
      title: '角色名称',
      dataIndex: 'name',
      width: 160,
      render: (name: string) => <span className="font-semibold">{name}</span>,
    },
    {
      title: '角色描述',
      dataIndex: 'description',
      width: 300,
      render: (description: string) => (
        <span className="whitespace-normal break-words text-muted-foreground">
          {description || '—'}
        </span>
      ),
    },
    {
      title: '角色标识',
      dataIndex: 'bizID',
      width: 210,
      render: (id: string) => (
        <span className="font-mono text-xs text-muted-foreground">{id}</span>
      ),
    },
    {
      title: '角色成员',
      key: 'members',
      width: 300,
      render: (_value: unknown, role: ForceRoleDTO) => (
        <MemberSummary role={role} />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_value: unknown, role: ForceRoleDTO) =>
        role.bizID === SUPER_ROLE ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <LockKeyhole className="size-3.5" />
            固定角色
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(true);
              setRemoving(null);
              setSelectedUserId(null);
            }}
          >
            编辑成员
          </Button>
        ),
    },
  ];

  if (access.isPending) return <LoadingState label="正在确认权限" />;
  if (access.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>无法确认权限</AlertTitle>
        <AlertDescription>{errorMessage(access.error)}</AlertDescription>
        <Button variant="outline" onClick={() => void access.refetch()}>
          重试
        </Button>
      </Alert>
    );
  if (!access.data.canManageAdmins)
    return (
      <div className="grid min-h-80 place-items-center rounded-2xl border bg-card text-center">
        <div className="space-y-4">
          <ShieldCheck className="mx-auto size-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold">仅高级管理员可访问</h1>
          <Button variant="outline" asChild>
            <Link to="/operations">返回运行中心</Link>
          </Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">管理员设置</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void roles.refetch()}
          disabled={roles.isFetching}
        >
          <RefreshCw
            className={`size-4 ${roles.isFetching ? 'animate-spin' : ''}`}
          />
          刷新
        </Button>
      </header>
      {roles.isError && (
        <Alert variant="destructive">
          <AlertTitle>无法加载管理员</AlertTitle>
          <AlertDescription>{errorMessage(roles.error)}</AlertDescription>
        </Alert>
      )}
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <Table<ForceRoleDTO>
          columns={columns}
          dataSource={roles.isError ? [] : roles.data || []}
          rowKey="bizID"
          loading={roles.isPending}
          pagination={false}
          scroll={{ x: 1100 }}
          size="middle"
          locale={{ emptyText: '暂无角色数据' }}
        />
      </div>
      <div className="flex items-start gap-3 rounded-xl border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>
          管理员可查看操作记录、调整运行设置及处理失败记录。普通登录用户均可使用业务协作功能；仅高级管理员可授权或移除管理员。
        </p>
      </div>
      <Dialog
        open={editing}
        onOpenChange={(open: boolean) => {
          if (!mutation.isPending) {
            setEditing(open);
            setRemoving(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>运行管理员</DialogTitle>
            <DialogDescription>
              逐人授权或撤销，只影响运行记录的查看范围。
            </DialogDescription>
          </DialogHeader>
          {roles.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                成员列表未能刷新，请关闭后重试。
              </AlertDescription>
            </Alert>
          )}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">已授权成员</h2>
            <div className="flex min-h-14 flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-3">
              {viewerUsers.length ? (
                viewerUsers.map((user: RoleUser, index: number) => (
                  <UserSelectTag
                    key={user.userID || index}
                    userValue={{
                      id: user.userID || '',
                      name: memberName(user),
                      avatar: user.avatar,
                    }}
                    onClose={() => setRemoving(user)}
                    disabled={
                      mutation.isPending || !user.userID || roles.isError
                    }
                    className={mutation.isPending ? '' : '!opacity-100'}
                  />
                ))
              ) : (
                <span className="text-sm text-muted-foreground">
                  尚未添加运行管理员
                </span>
              )}
            </div>
          </section>
          {removing ? (
            <Alert variant="warning" className="space-y-3">
              <AlertTitle>
                撤销 {memberName(removing)} 的运行管理员权限？
              </AlertTitle>
              <AlertDescription>
                该成员将无法继续查看全局运行记录，原有协作权限不受影响。
              </AlertDescription>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => setRemoving(null)}
                >
                  取消
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={mutation.isPending || !removing.userID}
                  onClick={() =>
                    mutation.mutate({
                      userId: removing.userID || '',
                      action: 'remove',
                    })
                  }
                >
                  确认撤销
                </Button>
              </div>
            </Alert>
          ) : (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">添加成员</h2>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <UserSelect
                  value={selectedUserId}
                  onChange={setSelectedUserId}
                  accountType="apaas"
                  closeOnSelect
                  disabled={mutation.isPending || roles.isError}
                  placeholder="选择成员"
                />
                <Button
                  size="sm"
                  disabled={
                    !selectedUserId ||
                    alreadyAdded ||
                    mutation.isPending ||
                    roles.isError
                  }
                  onClick={() => {
                    if (selectedUserId)
                      mutation.mutate({
                        userId: selectedUserId,
                        action: 'add',
                      });
                  }}
                >
                  {alreadyAdded ? '已授权' : '授权'}
                </Button>
              </div>
            </section>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setEditing(false)}
            >
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default OperationsAdminsPage;
