import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export function LoadingState({ label = '正在加载需求数据' }: { label?: string }) {
  return (
    <div className="grid min-h-[320px] place-items-center">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin text-primary" />
        {label}
      </div>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card className="border-destructive/25 bg-destructive/5">
      <CardContent className="flex min-h-52 flex-col items-center justify-center gap-3 py-10 text-center">
        <AlertCircle className="size-7 text-destructive" />
        <div>
          <p className="font-medium">暂时无法加载需求数据</p>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">{message}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-4" />
          重试
        </Button>
      </CardContent>
    </Card>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="grid min-h-52 place-items-center rounded-xl border border-dashed bg-card px-6 text-center">
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
