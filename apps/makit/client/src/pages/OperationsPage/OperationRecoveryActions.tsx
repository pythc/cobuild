import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { OperationRecord } from '@shared/api.interface';
import type { OperationRecoveryPreview } from '@/api/operations';
import { operationsApi } from '@/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
export function OperationRecoveryActions({
  item,
  onChanged,
}: {
  item: OperationRecord;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<OperationRecoveryPreview | null>(null),
    [consumer, setConsumer] = useState(''),
    [reason, setReason] = useState('');
  const inspect = useMutation({
    mutationFn: async () =>
      setPreview(await operationsApi.previewOperationRecovery(item.id)),
    onError: (error) => toast.error(error.message),
  });
  const save = useMutation({
    mutationFn: async () => {
      const result = preview
        ? await operationsApi.acknowledgeOperation(
            item.id,
            preview.digest,
            reason.trim(),
          )
        : await operationsApi.retryOperationConsumer(item.id, consumer);
      toast.success(result.message);
      setPreview(null);
      setConsumer('');
      onChanged();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {item.status === 'unknown' &&
          item.executionStage !== 'reviewed_unknown' && (
            <Button
              variant="outline"
              size="sm"
              disabled={inspect.isPending}
              onClick={() => inspect.mutate()}
            >
              核对并解除排队阻塞
            </Button>
          )}
        {item.stages
          .filter((stage) => stage.key !== 'write' && stage.status === 'failed')
          .map((stage) => (
            <Button
              key={stage.key}
              variant="outline"
              size="sm"
              onClick={() => setConsumer(stage.key)}
            >
              恢复{stage.label}
            </Button>
          ))}
      </div>
      <Dialog
        open={!!preview || !!consumer}
        onOpenChange={(open) => {
          if (!open && !save.isPending) {
            setPreview(null);
            setConsumer('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {preview ? '解除后续修改阻塞' : '恢复失败环节'}
            </DialogTitle>
            <DialogDescription>
              {preview?.warning ||
                '只恢复此失败环节，不再次修改需求。已发送的消息和结果不明的动作不会重放。'}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <p className="text-sm">
                {preview.code} {preview.title} · 当前 {preview.status}
              </p>
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                placeholder="请填写已核对的当前值和审计依据（至少 5 个字）"
              />
            </>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPreview(null);
                setConsumer('');
              }}
              disabled={save.isPending}
            >
              取消
            </Button>
            <Button
              disabled={
                save.isPending || (!!preview && reason.trim().length < 5)
              }
              onClick={() => save.mutate()}
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
