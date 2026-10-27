import type { FC } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const OperationsError: FC<{ message: string; onRetry: () => void }> = ({
  message,
  onRetry,
}) => (
  <div
    role="alert"
    className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-destructive/20 bg-destructive/5 p-5"
  >
    <div className="flex min-w-0 items-center gap-3">
      <AlertCircle className="size-5 shrink-0 text-destructive" />
      <p className="break-words text-sm">{message}</p>
    </div>
    <Button variant="outline" size="sm" onClick={onRetry}>
      重新加载
    </Button>
  </div>
);

export const OperationsPagination: FC<{
  page: number;
  pageCount: number;
  total: number;
  onChange: (page: number) => void;
}> = ({ page, pageCount, total, onChange }) => (
  <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
    <span>共 {total} 条</span>
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        variant="ghost"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </Button>
      <span>
        {page} / {Math.max(page, pageCount, 1)}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={page >= pageCount}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  </div>
);
