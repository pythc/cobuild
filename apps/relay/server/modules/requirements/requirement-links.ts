const DEFAULT_REQUIREMENT_PLATFORM_URL =
  'https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x';

function platformBaseUrl(): string {
  const configured: string =
    process.env.REQUIREMENT_PLATFORM_URL || DEFAULT_REQUIREMENT_PLATFORM_URL;
  return configured.replace(/\/+$/, '');
}

export function requirementPlatformUrl(recordId: string): string {
  return `${platformBaseUrl()}/requirements/${encodeURIComponent(recordId)}`;
}

export function iterationPlatformUrl(iterationId: string): string {
  const url: URL = new URL(`${platformBaseUrl()}/iterations`);
  url.searchParams.set('iteration', iterationId);
  return url.toString();
}

export function pullRequestPlatformUrl(pullNumber: number): string {
  return `${platformBaseUrl()}/pull-requests/${encodeURIComponent(String(pullNumber))}`;
}

export { DEFAULT_REQUIREMENT_PLATFORM_URL };
