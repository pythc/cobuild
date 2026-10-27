import type { Request } from 'express';
import type { AppConfig } from './config.js';
import { HttpError } from './errors.js';

export const EMBED_SESSION_COOKIE = 'lab_embedded_session';

export function parseEmbeddingOrigins(value: string | undefined): string[] {
  const entries = value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  if (entries.length > 8) throw new Error('EMBEDDING_ORIGINS supports at most eight exact origins');
  return [...new Set(entries.map((item) => {
    const url = new URL(item);
    if (!['https:', 'codex-sandbox:'].includes(url.protocol) || !url.hostname ||
        item.includes('*') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error('EMBEDDING_ORIGINS must contain exact HTTPS or Codex sandbox origins');
    }
    if (!/^[a-z0-9.-]+$/i.test(url.hostname) && !/^\[[a-f0-9:]+\]$/i.test(url.hostname)) {
      throw new Error('Unsupported embedding hostname');
    }
    if (url.protocol === 'codex-sandbox:' && !url.hostname.endsWith('.web-sandbox.oaiusercontent.com')) {
      throw new Error('Unsupported Codex sandbox host');
    }
    return `${url.protocol}//${url.host}`;
  }))];
}

export function usesEmbeddingSession(config: AppConfig, req: Request): boolean {
  const marker = req.header('x-lab-embedded');
  if (!marker) return false;
  if (marker !== '1' || !config.embeddingOrigins?.length || !config.cookieSecure) {
    throw new HttpError(403, '插件内登录尚未启用', 'EMBEDDING_DISABLED');
  }
  return true;
}
