import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  RequirementArtifactKind,
  RequirementArtifactSourceType,
  RequirementArtifactSummary,
  RequirementEngineeringResponse,
} from '@shared/api.interface';
import {
  ExternalLink,
  FileCode2,
  FileText,
  Link2,
  LoaderCircle,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { saveRequirementArtifact } from '@/api';
import RequirementAiReviewCard from '@/components/RequirementAiReviewCard';
import { TiptapEditorComplete } from '@/components/business-ui/tiptap-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRequirementEngineering } from '@/hooks/use-requirement-engineering';
import { errorMessage, formatDate } from '@/lib/requirement-utils';
import { cn } from '@/lib/utils';
import MaterialTemplateButton from './MaterialTemplateButton';
import { isOnlyMaterialTemplate } from '@shared/material-templates';

const DEFINITIONS = {
  technical_design: {
    title: '技术方案',
    description: '进入开发前必需，用于说明设计、数据、兼容、发布和回滚方案。',
    icon: FileCode2,
    reviewType: 'technical_stability' as const,
    placeholder: '从创建、配置、生效、使用四个场景展开技术方案，并说明风险与验证方式',
  },
  self_test_report: {
    title: '自测报告',
    description: '开发转测试前必需，用于记录覆盖范围、验证结果、证据与遗留风险。',
    icon: FileText,
    reviewType: 'delivery_readiness' as const,
    placeholder: '记录测试环境、覆盖范围、执行步骤、预期与实际结果、回归项和遗留风险',
  },
};

function ArtifactSection({
  requirementId,
  kind,
  data,
  onUpdated,
  focusRequest,
}: {
  requirementId: string;
  kind: RequirementArtifactKind;
  data: RequirementEngineeringResponse;
  onUpdated: (value: RequirementEngineeringResponse) => void;
  focusRequest?: { kind: RequirementArtifactKind; nonce: number };
}) {
  const definition = DEFINITIONS[kind];
  const artifact: RequirementArtifactSummary | null = data.artifacts[kind];
  const review = data.reviews[definition.reviewType];
  const Icon = definition.icon;
  const [open, setOpen] = useState(false);
  const [sourceType, setSourceType] = useState<RequirementArtifactSourceType>('inline');
  const [content, setContent] = useState('');
  const [documentUrl, setDocumentUrl] = useState('');
  useEffect(() => { if (focusRequest?.kind === kind) setOpen(true); }, [focusRequest?.nonce, focusRequest?.kind, kind]);

  useEffect(() => {
    if (!open) return;
    setSourceType(artifact?.sourceType || 'inline');
    setContent(artifact?.content || '');
    setDocumentUrl(artifact?.documentUrl || '');
  }, [artifact, open]);

  const saveMutation = useMutation({
    mutationFn: () =>
      saveRequirementArtifact(requirementId, kind, {
        sourceType,
        content: sourceType === 'inline' ? content : undefined,
        documentUrl: sourceType === 'feishu_doc' ? documentUrl : undefined,
      }),
    onSuccess: (value) => {
      onUpdated(value);
      setOpen(false);
      toast.success('已保存');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <section className="overflow-hidden rounded-2xl border bg-background shadow-sm shadow-slate-200/40">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b bg-gradient-to-r from-primary/[0.07] via-background to-background px-5 py-4">
        <div className="flex min-w-0 gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Icon className="size-5" />
          </span>
          <div>
            <h2 className="font-semibold">{definition.title}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{definition.description}</p>
          </div>
        </div>
        {data.canUpdate ? (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Pencil className="size-3.5" />
            {artifact ? '修改' : '添加'}
          </Button>
        ) : null}
      </div>

      <div className="space-y-4 p-5">
        {artifact ? (
          <div className={cn('rounded-xl border p-4', !artifact.readable && 'border-red-200 bg-red-50/40')}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">
                  {artifact.sourceType === 'inline' ? '在线内容' : '飞书云文档'}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {artifact.updatedByName} · {formatDate(artifact.updatedAt, true)}
                </span>
              </div>
              {artifact.sourceType === 'feishu_doc' && artifact.documentUrl ? (
                <Button variant="ghost" size="sm" asChild>
                  <a href={artifact.documentUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" />
                    打开文档
                  </a>
                </Button>
              ) : null}
            </div>
            {artifact.sourceType === 'inline' ? (
              <div className="mt-3 max-h-52 overflow-y-auto rounded-lg bg-muted/35 p-3 text-sm leading-6">
                <TiptapEditorComplete value={artifact.content} readOnly className="min-h-0 w-full" />
              </div>
            ) : artifact.readable ? (
              <div className="mt-3 flex items-center gap-2 text-sm">
                <Link2 className="size-4 text-primary" />
                <span className="font-medium">{artifact.documentTitle || '飞书文档'}</span>
                <span className="text-xs text-muted-foreground">已读取正文并用于本次评审</span>
              </div>
            ) : (
              <p className="mt-3 text-sm text-red-700">{artifact.errorMessage}</p>
            )}
          </div>
        ) : (
          <button
            type="button"
            disabled={!data.canUpdate}
            onClick={() => setOpen(true)}
            className="flex w-full flex-col items-center rounded-xl border border-dashed px-5 py-9 text-center transition-colors enabled:hover:border-primary/45 enabled:hover:bg-primary/[0.03] disabled:cursor-default"
          >
            <Icon className="size-7 text-muted-foreground" />
            <span className="mt-3 text-sm font-medium">尚未添加{definition.title}</span>
            <span className="mt-1 text-xs text-muted-foreground">支持在线填写或粘贴飞书云文档链接</span>
          </button>
        )}

        <RequirementAiReviewCard
          requirementId={requirementId}
          review={review}
          canUpdate={data.canUpdate && Boolean(artifact?.readable)}
          canOverride={data.canOverride}
          onUpdated={onUpdated}
        />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{artifact ? '修改' : '添加'}{definition.title}</DialogTitle>
            <DialogDescription>
              保存后立即返回，后台会自动执行{REVIEW_LABEL(definition.reviewType)}。
            </DialogDescription>
          </DialogHeader>
          <Tabs
            value={sourceType}
            onValueChange={(value) => setSourceType(value as RequirementArtifactSourceType)}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="inline"><FileText className="size-4" />在线填写</TabsTrigger>
              <TabsTrigger value="feishu_doc"><Link2 className="size-4" />飞书文档</TabsTrigger>
            </TabsList>
            <TabsContent value="inline" className="mt-4">
              <div className="mb-3 flex justify-end"><MaterialTemplateButton kind={kind} value={content} onChange={setContent} /></div>
              <TiptapEditorComplete
                value={content}
                onValueChange={setContent}
                placeholder={definition.placeholder}
                className="min-h-80 w-full"
              />
            </TabsContent>
            <TabsContent value="feishu_doc" className="mt-4 space-y-3">
              <Input
                value={documentUrl}
                onChange={(event) => setDocumentUrl(event.target.value)}
                placeholder="https://...feishu.cn/docx/..."
              />
              <div className="rounded-lg border bg-muted/35 px-4 py-3 text-sm leading-6 text-muted-foreground">
                系统会以应用身份读取文档正文。请先把文档共享给“周催办”应用；链接不变时不会主动轮询文档内部修改。
              </div>
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={
                saveMutation.isPending ||
                (sourceType === 'inline' ? !content.trim() || isOnlyMaterialTemplate(content, kind) : !documentUrl.trim())
              }
            >
              {saveMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function REVIEW_LABEL(type: 'technical_stability' | 'delivery_readiness'): string {
  return type === 'technical_stability' ? '技术与稳定性评审' : '交付准备评审';
}

export default function RequirementEngineeringPanel({
  requirementId,
  focusRequest,
}: {
  requirementId: string;
  focusRequest?: { kind: RequirementArtifactKind; nonce: number };
}) {
  const queryClient = useQueryClient();
  const query = useRequirementEngineering(requirementId);
  const update = (value: RequirementEngineeringResponse): void => {
    queryClient.setQueryData(['requirement', requirementId, 'engineering'], value);
  };
  if (query.isLoading) {
    return (
      <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
        <LoaderCircle className="mb-2 size-5 animate-spin" />
        正在加载研发资料
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="grid min-h-64 place-items-center rounded-xl border border-dashed text-center">
        <div>
          <p className="text-sm text-destructive">{errorMessage(query.error)}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void query.refetch()}>
            <RefreshCw className="size-3.5" />重试
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <ArtifactSection requirementId={requirementId} kind="technical_design" data={query.data} onUpdated={update} focusRequest={focusRequest} />
      <ArtifactSection requirementId={requirementId} kind="self_test_report" data={query.data} onUpdated={update} focusRequest={focusRequest} />
    </div>
  );
}
