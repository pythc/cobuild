import { BadRequestException } from '@nestjs/common';
import * as path from 'node:path';
export const OFFICE_LIMIT = 50 * 1024 * 1024;
export const OFFICE_TYPES = ['docx', 'xlsx', 'pptx'] as const;
export function fileName(value: string) {
  const name = path
    .basename(value.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 180);
  if (!name || name === '.' || name === '..')
    throw new BadRequestException('文件名不能为空');
  return name;
}
export function extension(name: string) {
  const ext = path.extname(name).slice(1).toLowerCase();
  // Unknown long suffixes are ordinary files, never overflow the metadata column.
  return ext.length <= 16 ? ext : '';
}
export function officeType(ext: string) {
  if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext)) return 'word';
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'cell';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return 'slide';
  return null;
}
export function modernExtension(ext: string) {
  const type = officeType(ext);
  return type === 'word'
    ? 'docx'
    : type === 'cell'
      ? 'xlsx'
      : type === 'slide'
        ? 'pptx'
        : null;
}
export function engineUrl(value: string, origins: string[]) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('编辑服务返回了无效地址');
  }
  if (
    url.username ||
    url.password ||
    !['http:', 'https:'].includes(url.protocol) ||
    !origins.some((origin) => new URL(origin).origin === url.origin)
  )
    throw new BadRequestException('编辑服务地址不在允许范围内');
  return url.toString();
}
