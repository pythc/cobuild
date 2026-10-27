export type MaterialTemplateKind =
  | 'technical_design'
  | 'self_test_report'
  | 'defect_cause';
export const MATERIAL_TEMPLATES: Record<
  MaterialTemplateKind,
  { title: string; sections: string[] }
> = {
  technical_design: {
    title: '技术方案',
    sections: [
      '目标与范围',
      '现状与约束',
      '创建：入口、数据与边界',
      '配置：参数、权限与默认值',
      '生效：变更、兼容与迁移',
      '使用：主流程与异常流程',
      '稳定性、资源开销与安全',
      '验证计划',
      '发布、回滚与观测',
    ],
  },
  self_test_report: {
    title: '自测报告',
    sections: [
      '测试版本、环境与执行人',
      '覆盖范围与未覆盖范围',
      '用例、步骤、预期与实际结果',
      '异常与回归验证',
      '日志、截图或报告链接',
      '遗留问题、风险与交接说明',
    ],
  },
  defect_cause: {
    title: '缺陷原因',
    sections: [
      '问题现象与影响范围',
      '根本原因',
      '修复措施',
      '验证结果与防止复发',
    ],
  },
};
export function materialTemplate(
  kind: MaterialTemplateKind,
  html: boolean = true,
): string {
  return MATERIAL_TEMPLATES[kind].sections
    .map((title) => (html ? `<h2>${title}</h2><p></p>` : `${title}：\n`))
    .join(html ? '' : '\n');
}
const normalized = (value: string) =>
  value
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/gu, '')
    .replace(/[\s：:]/gu, '');
export function isOnlyMaterialTemplate(
  value: string,
  kind: MaterialTemplateKind,
): boolean {
  return normalized(value) === normalized(materialTemplate(kind));
}
