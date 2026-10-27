/** Keep the array-shaped API for compatibility, but never accept multiple links. */
export function iterationAssignmentError(value: unknown): string | null {
  if (
    !Array.isArray(value) ||
    value.some(
      (id: unknown) => typeof id !== 'string' || !id.trim() || id !== id.trim(),
    )
  ) {
    return '所属迭代格式不正确，请重新选择';
  }
  if (value.length > 1) return '一个需求只能关联一个迭代，请选择唯一的所属迭代';
  return null;
}
