import { createHash } from 'node:crypto';
import type { RequirementArtifactKind, RequirementSummary } from '@shared/api.interface';
import { isOnlyMaterialTemplate } from '@shared/material-templates';
import { hasMeaningfulText } from './requirements.model';

export interface SelfTestReportArtifact extends Record<string, unknown> {
  requirement_id: string;
  kind: RequirementArtifactKind;
  source_type: 'inline' | 'feishu_doc';
  content: string;
  document_url: string;
  document_title: string;
  source_snapshot: string;
  source_hash: string;
  readable: boolean;
  error_message: string;
  updated_by_name: string;
  _updated_at: Date | string | number | null;
}

/** An explicit artifact is authoritative, including an empty or unreadable one. */
export function resolveSelfTestReport(
  requirement: Pick<RequirementSummary, 'id' | 'selfTestReport' | 'updatedAt'>,
  artifacts: readonly SelfTestReportArtifact[],
  legacyOverride?: string,
): SelfTestReportArtifact | undefined {
  const current = artifacts.find(
    (item) => item.requirement_id === requirement.id && item.kind === 'self_test_report',
  );
  if (current) return current;
  const content = (legacyOverride ?? requirement.selfTestReport ?? '').trim();
  if (!hasMeaningfulText(content)) return undefined;
  // Read-only compatibility: displaying or checking an old report never writes it.
  return {
    requirement_id: requirement.id,
    kind: 'self_test_report',
    source_type: 'inline',
    content,
    document_url: '',
    document_title: '',
    source_snapshot: content,
    source_hash: createHash('sha256').update(`inline\n\n${content}`).digest('hex'),
    readable: true,
    error_message: '',
    updated_by_name: '',
    _updated_at: requirement.updatedAt ?? null,
  };
}

export function selfTestReportReadiness(
  artifact?: SelfTestReportArtifact,
): { passed: boolean; detail: string } {
  if (!artifact || artifact.kind !== 'self_test_report')
    return { passed: false, detail: '缺少有效自测报告' };
  if (!artifact.readable)
    return { passed: false, detail: '自测报告暂时无法读取，请检查文档权限或重新保存' };
  const text = artifact.source_type === 'inline' ? artifact.content : artifact.source_snapshot;
  if (!hasMeaningfulText(text))
    return { passed: false, detail: '缺少有效自测报告' };
  if (isOnlyMaterialTemplate(text, 'self_test_report'))
    return { passed: false, detail: '自测报告仅包含空模板，请填写实际测试内容' };
  return { passed: true, detail: '已填写' };
}
