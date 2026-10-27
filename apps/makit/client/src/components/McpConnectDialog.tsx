import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  RotateCw,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  McpCredentialResponse,
  McpCredentialStatus,
} from '@shared/api.interface';
import {
  getMcpCredentialStatus,
  issueMcpCredential,
  rotateMcpCredential,
} from '@/api';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { createMcpConnectionCode } from '@/lib/mcp-connection-code';

const BOOTSTRAP_COMMAND: string =
  'python3 ai-homework-requirement-dev/scripts/bootstrap.py ' +
  '--workspace <工作区> --connect';

function publicCredentialStatus(
  value: McpCredentialResponse,
): McpCredentialStatus {
  return {
    available: value.available,
    issued: value.issued,
    endpoint: value.endpoint,
    personalTokenPreview: value.personalTokenPreview,
    userName: value.userName,
  };
}

const McpConnectDialog: FC = () => {
  const [open, setOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [statusError, setStatusError] = useState<boolean>(false);
  const [status, setStatus] = useState<McpCredentialStatus | null>(null);
  const [credential, setCredential] = useState<McpCredentialResponse | null>(
    null,
  );
  const [copied, setCopied] = useState<boolean>(false);
  const requestVersionRef = useRef<number>(0);

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const requestVersion: number = ++requestVersionRef.current;
    setLoading(true);
    setStatusError(false);
    void getMcpCredentialStatus()
      .then((value: McpCredentialStatus): void => {
        if (requestVersion === requestVersionRef.current) setStatus(value);
      })
      .catch((error: unknown): void => {
        if (requestVersion === requestVersionRef.current) {
          setStatusError(true);
          toast.error(
            error instanceof Error ? error.message : '获取 MCP 接入状态失败',
          );
        }
      })
      .finally((): void => {
        if (requestVersion === requestVersionRef.current) setLoading(false);
      });
    return (): void => {
      if (requestVersion === requestVersionRef.current) {
        requestVersionRef.current += 1;
      }
    };
  }, [open]);

  const connectionCode: string = useMemo((): string => {
    return credential ? createMcpConnectionCode(credential) : '';
  }, [credential]);

  const runCredentialAction = async (
    action: () => Promise<McpCredentialResponse>,
    successMessage?: string,
  ): Promise<void> => {
    const requestVersion: number = ++requestVersionRef.current;
    setLoading(true);
    try {
      const value: McpCredentialResponse = await action();
      if (requestVersion !== requestVersionRef.current) return;
      setCredential(value);
      setStatus(publicCredentialStatus(value));
      setStatusError(false);
      setCopied(false);
      if (successMessage) toast.success(successMessage);
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return;
      toast.error(error instanceof Error ? error.message : '获取连接码失败');
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  };

  const handleCopy = async (): Promise<void> => {
    if (!connectionCode) return;
    try {
      await navigator.clipboard.writeText(connectionCode);
      setCopied(true);
      toast.success('连接码已复制');
    } catch {
      toast.error('复制失败，请重试');
    }
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      requestVersionRef.current += 1;
      setCredential(null);
      setStatus(null);
      setStatusError(false);
      setCopied(false);
      setLoading(false);
    }
    setOpen(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-ai-section-type="button">
          <KeyRound className="size-4" />
          MCP 接入
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pr-12 pb-4">
          <DialogTitle>连接 Makit</DialogTitle>
          <DialogDescription>
            Codex、CodeBuddy 和 Claude Code 通用，只需初始化一次。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5">
          <div className="rounded-lg border bg-muted/35 p-4 text-sm">
            <div className="font-medium">{status?.userName || '当前用户'}</div>
            <div className="mt-1 text-muted-foreground">
              {statusError
                ? '接入状态检查失败，请关闭后重试'
                : !status
                  ? '正在检查接入状态…'
                  : status.available === false
                    ? 'MCP 接入尚未就绪'
                    : status.issued
                      ? '连接码已生成'
                      : '尚未生成连接码'}
            </div>
          </div>

          {credential ? (
            <>
              <div className="rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                    1
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">复制连接码</div>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      一个连接码已包含需求平台地址和你的身份，无需再区分两个
                      Key。
                    </p>
                    <div className="mt-3 flex items-center gap-3 rounded-md bg-slate-950 px-3 py-2 text-xs text-slate-100">
                      <code className="min-w-0 flex-1 truncate">
                        {connectionCode.slice(0, 28)}••••••••
                      </code>
                      <ShieldCheck className="size-4 shrink-0 text-emerald-400" />
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                    2
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">运行一次初始化</div>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      把 Skill 包交给
                      Agent，让它运行下面的命令，然后粘贴刚复制的
                      连接码。凭据会进入工作区外、仅当前用户可读的私有存储，配置文件不保存密钥。
                    </p>
                    <pre className="mt-3 max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-slate-950 p-3 text-xs leading-5 text-slate-100">
                      {BOOTSTRAP_COMMAND}
                    </pre>
                  </div>
                </div>
              </div>

              <p className="text-xs leading-5 text-muted-foreground">
                首次使用只需批准 ai_homework_requirements 和 github_official
                两个固定 MCP Server。重新生成连接码后，旧连接码会立即失效。
              </p>
            </>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t bg-background px-6 py-4">
          {credential ? (
            <>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    disabled={loading}
                    data-ai-section-type="button"
                  >
                    <RotateCw className="size-4" />
                    重新生成
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>重新生成连接码？</AlertDialogTitle>
                    <AlertDialogDescription>
                      旧连接码会立即失效，已经连接的 Agent 需要重新初始化。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(): void => {
                        setCredential(null);
                        setCopied(false);
                        void runCredentialAction(
                          rotateMcpCredential,
                          '连接码已重新生成',
                        );
                      }}
                    >
                      确认重新生成
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button onClick={handleCopy} data-ai-section-type="button">
                {copied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
                {copied ? '已复制' : '复制连接码'}
              </Button>
            </>
          ) : (
            <Button
              onClick={(): void => {
                void runCredentialAction(issueMcpCredential);
              }}
              disabled={
                loading || statusError || !status || status.available === false
              }
              data-ai-section-type="button"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              {status?.issued ? '查看连接码' : '获取连接码'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default McpConnectDialog;
