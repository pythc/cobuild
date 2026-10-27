import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AiPricing,
  OperationsSettings,
} from '@shared/operations-insights.interface';
import * as api from '@/api/operations-insights';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { OperationsError } from './OperationsCommon';

export function OperationsSettingsDialog({
  userId,
  open,
  onOpenChange,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const query = useQuery({
    queryKey: ['operations', 'insights', 'settings', userId],
    queryFn: ({ signal }) => api.getSettings(signal),
    enabled: open,
    retry: false,
  });
  const [draft, setDraft] = useState<OperationsSettings | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(null);
  }, [userId]);
  useEffect(() => {
    if (open && query.data) {
      setDraft(structuredClone(query.data));
    }
  }, [query.data, open]);
  const update = (next: OperationsSettings) => {
    setDraft(next);
  };
  const changePrice = (patch: Partial<AiPricing>) => {
    if (draft?.ai.pricing)
      update({
        ...draft,
        ai: { ...draft.ai, pricing: { ...draft.ai.pricing, ...patch } },
      });
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await api.saveSettings({
        ...draft,
        alerts: { ...draft.alerts, enabled: false },
      });
      setDraft(saved);
      toast.success('已修改');
      onOpenChange(false);
      void query.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '修改失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>运行设置</DialogTitle>
        </DialogHeader>
        {query.isError ? (
          <OperationsError
            message={query.error.message}
            onRetry={() => void query.refetch()}
          />
        ) : draft ? (
          <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
            <fieldset
              disabled={busy}
              className="min-w-0 space-y-5 disabled:opacity-60"
            >
              <section className="rounded-xl border p-4">
                <h2 className="font-semibold">AI 评审</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <label className="space-y-2 text-sm">
                    <span>全局并发上限</span>
                    <Input
                      type="number"
                      min={1}
                      max={8}
                      value={draft.ai.concurrency}
                      onChange={(event) =>
                        update({
                          ...draft,
                          ai: {
                            ...draft.ai,
                            concurrency: Number(event.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <label className="space-y-2 text-sm">
                    <span>连续编辑合并窗口（秒）</span>
                    <Input
                      type="number"
                      min={2}
                      max={60}
                      value={draft.ai.debounceSeconds}
                      onChange={(event) =>
                        update({
                          ...draft,
                          ai: {
                            ...draft.ai,
                            debounceSeconds: Number(event.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <label className="space-y-2 text-sm">
                    <span>每日预算提醒</span>
                    <Input
                      type="number"
                      min={0}
                      value={draft.ai.dailyBudget ?? ''}
                      placeholder="不设置"
                      onChange={(event) =>
                        update({
                          ...draft,
                          ai: {
                            ...draft.ai,
                            dailyBudget:
                              event.target.value === ''
                                ? null
                                : Number(event.target.value),
                          },
                        })
                      }
                    />
                  </label>
                </div>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">
                  预算按北京时间自然日、已配置币种统计；超额只提醒，不自动停掉必需评审。
                </p>
                <label className="mt-4 flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={!!draft.ai.pricing}
                    onCheckedChange={(checked) =>
                      update({
                        ...draft,
                        ai: {
                          ...draft.ai,
                          pricing: checked
                            ? {
                                version: '',
                                model: 'deepseek-v4-flash',
                                currency: 'CNY',
                                inputPerMillion: 0,
                                cachedInputPerMillion: null,
                                outputPerMillion: 0,
                                effectiveAt: new Date().toISOString(),
                              }
                            : null,
                        },
                      })
                    }
                  />
                  配置费用估算单价
                </label>
                {draft.ai.pricing && (
                  <div className="mt-4 grid gap-4 rounded-lg bg-muted/35 p-4 sm:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span>价格版本</span>
                      <Input
                        value={draft.ai.pricing.version}
                        placeholder="例如 2026-09-contract-v1"
                        onChange={(event) =>
                          changePrice({ version: event.target.value })
                        }
                      />
                    </label>
                    <label className="space-y-2 text-sm">
                      <span>模型名称</span>
                      <Input
                        value={draft.ai.pricing.model}
                        onChange={(event) =>
                          changePrice({ model: event.target.value })
                        }
                      />
                    </label>
                    <label className="space-y-2 text-sm">
                      <span>币种</span>
                      <Select
                        value={draft.ai.pricing.currency}
                        onValueChange={(value) =>
                          changePrice({ currency: value as 'CNY' | 'USD' })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="CNY">人民币 CNY</SelectItem>
                          <SelectItem value="USD">美元 USD</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="space-y-2 text-sm">
                      <span>生效时间</span>
                      <Input
                        type="datetime-local"
                        value={new Date(
                          Date.parse(draft.ai.pricing.effectiveAt) -
                            new Date().getTimezoneOffset() * 60000,
                        )
                          .toISOString()
                          .slice(0, 16)}
                        onChange={(event) => {
                          if (event.target.value)
                            changePrice({
                              effectiveAt: new Date(
                                event.target.value,
                              ).toISOString(),
                            });
                        }}
                      />
                    </label>
                    {(
                      [
                        'inputPerMillion',
                        'cachedInputPerMillion',
                        'outputPerMillion',
                      ] as const
                    ).map((key) => (
                      <label key={key} className="space-y-2 text-sm">
                        <span>
                          {
                            {
                              inputPerMillion: '输入 / 百万 token',
                              cachedInputPerMillion:
                                '缓存命中输入 / 百万 token（可选）',
                              outputPerMillion: '输出 / 百万 token',
                            }[key]
                          }
                        </span>
                        <Input
                          type="number"
                          min={0}
                          step="0.0001"
                          value={draft.ai.pricing![key] ?? ''}
                          onChange={(event) =>
                            changePrice({
                              [key]:
                                event.target.value === '' &&
                                key === 'cachedInputPerMillion'
                                  ? null
                                  : Number(event.target.value),
                            })
                          }
                        />
                      </label>
                    ))}
                    <p className="text-xs leading-6 text-muted-foreground sm:col-span-2">
                      按实际合同或供应商价格填写；改变单价须使用新版本，历史执行保留当时价格快照。
                    </p>
                  </div>
                )}
              </section>
            </fieldset>
          </div>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            读取设置中…
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={busy || !draft || query.isError}
            onClick={() => void save()}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
