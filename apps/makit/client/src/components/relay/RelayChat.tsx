import { useEffect, useRef, useState } from 'react';
import { Paperclip, Send, X, LockKeyhole, LoaderCircle } from 'lucide-react';
import type {
  RelayAttachment,
  RelayConversation,
  RelaySendMessage,
} from '@shared/api.interface';
import { relayRequest } from '@/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { relayError } from './use-relay';
import { RelayAttachmentView } from './RelayAttachmentView';

export function RelayChat({
  conversation,
  operator = false,
  onSent,
}: {
  conversation: RelayConversation;
  operator?: boolean;
  onSent: () => void;
}) {
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<RelayAttachment[]>([]);
  const [privateNote, setPrivateNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ key: string; body: RelaySendMessage } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [conversation.messages.length]);
  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    if (selected.some((file) => !file.size || file.name.length > 200)) {
      setError('附件不能为空，文件名最多 200 个字符');
      return;
    }
    if (selected.some((file) => file.size > 5 * 1024 * 1024)) {
      setError('单个附件不能超过 5 MB');
      return;
    }
    if (
      selected.length + attachments.length > 3 ||
      [
        ...selected.map((f) => f.size),
        ...attachments.map((f) => Number(f.size)),
      ].reduce((a, b) => a + b, 0) >
        6 * 1024 * 1024
    ) {
      setError('每次最多 3 个附件，合计不超过 6 MB');
      return;
    }
    setLoadingFiles(true);
    setError('');
    try {
      const next = await Promise.all(
        selected.map(
          (file) =>
            new Promise<RelayAttachment>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(new Error('附件读取失败'));
              reader.onload = () =>
                resolve({
                  name: file.name,
                  kind: file.type.startsWith('image/') ? 'image' : 'text',
                  size: String(file.size),
                  data: String(reader.result),
                });
              reader.readAsDataURL(file);
            }),
        ),
      );
      setAttachments((current) => [...current, ...next]);
    } catch (e) {
      setError(relayError(e));
    } finally {
      setLoadingFiles(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const send = async () => {
    if (busy || loadingFiles || (!content.trim() && !attachments.length))
      return;
    const body = { content, attachments, private: operator && privateNote };
    const attempt = pending.current || { key: crypto.randomUUID(), body };
    pending.current = attempt;
    setBusy(true);
    setError('');
    try {
      await relayRequest(
        '/api/relay/conversations/' +
          conversation.id +
          '/messages?view=' +
          (operator ? 'operator' : 'customer'),
        'POST',
        attempt.body,
        attempt.key,
      );
      pending.current = null;
      setContent('');
      setAttachments([]);
      onSent();
    } catch (e) {
      if (
        e &&
        typeof e === 'object' &&
        'status' in e &&
        typeof e.status === 'number' &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 409 &&
        e.status !== 429
      )
        pending.current = null;
      setError(relayError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-muted/15 p-5"
        aria-live="polite"
        aria-label="咨询消息"
      >
        {!conversation.messages.length && (
          <p className="py-12 text-center text-sm text-muted-foreground">
            有什么可以帮你？
          </p>
        )}
        {conversation.messages
          .filter((m) => m.side !== 'system')
          .map((m) => (
            <div
              key={m.id}
              className={
                'flex flex-col gap-1 ' +
                (m.side === 'customer' ? 'items-end' : 'items-start')
              }
            >
              <span className="text-xs text-muted-foreground">
                {m.senderName ||
                  (m.side === 'customer' ? conversation.name : '客服')}{' '}
                ·{' '}
                {new Date(m.time).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <div
                className={
                  'max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 ' +
                  (m.private
                    ? 'border border-amber-200 bg-amber-50 text-amber-950'
                    : m.side === 'customer'
                      ? 'bg-primary/10 text-foreground'
                      : 'border bg-background')
                }
              >
                {m.private && (
                  <span className="mb-1 flex items-center gap-1 text-xs text-amber-700">
                    <LockKeyhole className="size-3" />
                    内部备注
                  </span>
                )}
                <p className="whitespace-pre-wrap break-words">{m.content}</p>
                {m.attachments.map((f, i) => (
                  <RelayAttachmentView key={f.id || i} file={f} />
                ))}
              </div>
            </div>
          ))}
        <div ref={bottom} />
      </div>
      <div className="space-y-2 border-t bg-background p-3">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((f, i) => (
              <div
                key={i}
                className="flex max-w-full items-center gap-1 rounded-lg border bg-muted/25 p-1.5 text-xs"
              >
                {f.kind === 'image' && (
                  <img
                    src={f.data}
                    alt=""
                    className="size-9 rounded object-cover"
                  />
                )}
                <span className="max-w-40 truncate">{f.name}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy || !!pending.current}
                  aria-label={'移除' + f.name}
                  onClick={() =>
                    setAttachments((a) => a.filter((_, n) => n !== i))
                  }
                >
                  <X className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
            {pending.current && '；再次发送会核对原请求，不会重复发送。'}
          </p>
        )}
        {operator && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={privateNote}
              disabled={busy || !!pending.current}
              onCheckedChange={(v) => setPrivateNote(v === true)}
            />
            内部备注，不显示在用户聊天中
          </label>
        )}
        <Textarea
          aria-label={privateNote ? '内部备注' : '消息内容'}
          maxLength={10000}
          placeholder={privateNote ? '添加内部备注…' : '输入消息…'}
          value={content}
          disabled={busy || !!pending.current}
          onChange={(e) => setContent(e.target.value)}
          className="max-h-32 min-h-20 resize-none border-0 shadow-none focus-visible:ring-0"
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center justify-between gap-3">
          <input
            ref={fileInput}
            className="hidden"
            type="file"
            multiple
            onChange={(e) => void attach(e.target.files)}
            aria-label="选择附件"
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="添加附件"
            disabled={busy || loadingFiles || !!pending.current}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
          <Button
            size="sm"
            disabled={
              busy || loadingFiles || (!content.trim() && !attachments.length)
            }
            onClick={() => void send()}
          >
            {busy || loadingFiles ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            {pending.current && !busy ? '重试发送' : '发送'}
          </Button>
        </div>
      </div>
    </div>
  );
}
