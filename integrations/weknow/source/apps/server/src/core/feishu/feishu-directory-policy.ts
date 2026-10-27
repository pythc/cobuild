import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

export const DIRECTORY_MAX_AGE_MS = 15 * 60 * 1000;
export const DIRECTORY_INTERVAL_MS = 5 * 60 * 1000;
export type DirectoryStatus =
  | 'active'
  | 'frozen'
  | 'resigned'
  | 'exited'
  | 'unactivated'
  | 'out_of_scope'
  | 'unknown';

export function directoryEnabled(config: {
  get: (key: string, fallback?: any) => any;
}) {
  return config.get('FEISHU_SYNC_ENABLED', 'false') === 'true';
}

export function memberStatus(status: any): DirectoryStatus {
  if (
    !status ||
    ['is_frozen', 'is_resigned', 'is_exited', 'is_activated'].some(
      (k) => typeof status[k] !== 'boolean',
    )
  ) {
    throw new ServiceUnavailableException(
      '飞书未返回完整成员状态，请检查通讯录权限',
    );
  }
  if (status.is_resigned) return 'resigned';
  if (status.is_exited) return 'exited';
  if (status.is_frozen) return 'frozen';
  if (!status.is_activated) return 'unactivated';
  return 'active';
}

export function assertDirectoryAccess(identity: any, now = Date.now()) {
  if (!identity || identity.directoryStatus !== 'active')
    throw new UnauthorizedException('飞书成员不可用');
  const checked =
    identity.directoryCheckedAt &&
    new Date(identity.directoryCheckedAt).getTime();
  if (
    !checked ||
    checked > now + 60000 ||
    now - checked > DIRECTORY_MAX_AGE_MS
  ) {
    throw new ServiceUnavailableException('飞书成员验证暂时不可用，请稍后重试');
  }
}

export function safeFeishuAvatar(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const hosts = [
      'feishucdn.com',
      'byteimg.com',
      'larksuitecdn.com',
      'larkoffice.com',
    ];
    return hosts.some(
      (h) => url.hostname === h || url.hostname.endsWith('.' + h),
    )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
