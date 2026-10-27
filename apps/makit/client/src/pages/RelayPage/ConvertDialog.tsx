import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, Plus } from 'lucide-react';
import type {
  RelayConversation,
  RelayCreateTicket,
  RelayTicket,
} from '@shared/api.interface';
import { relayRequest } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { relayError } from '@/components/relay/use-relay';
interface RelayMember {
  id: string;
  name: string;
  isCurrent: boolean;
}
export default function ConvertDialog({
  conversation,
  onClose,
  onCreated,
}: {
  conversation: RelayConversation;
  onClose: () => void;
  onCreated: (ticket: RelayTicket) => void;
}) {
  const members = useQuery({
    queryKey: ['relay', 'members'],
    queryFn: () => relayRequest<RelayMember[]>('/api/support/members'),
  });
  const [title, setTitle] = useState(conversation.title || '');
  const [description, setDescription] = useState(
    conversation.messages.find((m) => m.side === 'customer')?.content || '',
  );
  const [priority, setPriority] =
    useState<RelayCreateTicket['priority']>('普通');
  const [handlers, setHandlers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      const ticket = await relayRequest<RelayTicket>(
        '/api/support/tickets',
        'POST',
        {
          conversationId: conversation.id,
          title,
          description,
          priority,
          handlerIds: handlers,
        },
      );
      onCreated(ticket);
    } catch (e) {
      setError(relayError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>创建工单</DialogTitle>
          <DialogDescription>
            将当前对话与附件自动附入 Makit 的「工单」项目。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="relay-title">标题</Label>
            <Input
              id="relay-title"
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="relay-description">问题说明</Label>
            <Textarea
              id="relay-description"
              maxLength={20000}
              className="min-h-24"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label>优先级</Label>
            <Select
              value={priority}
              onValueChange={(v) =>
                setPriority(v as RelayCreateTicket['priority'])
              }
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['较低', '普通', '紧急'] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="mb-2 text-sm font-medium">当前处理人</legend>
            {members.isLoading ? (
              <p className="text-sm text-muted-foreground">正在加载成员…</p>
            ) : members.error ? (
              <p role="alert" className="text-sm text-destructive">
                {relayError(members.error)}
                <Button variant="ghost" onClick={() => void members.refetch()}>
                  重试
                </Button>
              </p>
            ) : (
              <div className="flex max-h-36 flex-wrap gap-3 overflow-y-auto">
                {members.data?.map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <Checkbox
                      checked={handlers.includes(m.id)}
                      onCheckedChange={(checked) =>
                        setHandlers((v) =>
                          checked ? [...v, m.id] : v.filter((x) => x !== m.id),
                        )
                      }
                    />
                    {m.name}
                    {m.isCurrent ? '（我）' : ''}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={
              busy || !title.trim() || members.isLoading || members.isError
            }
            onClick={() => void create()}
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            创建工单
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
