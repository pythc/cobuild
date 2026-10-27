export const DEFAULT_REQUIREMENT_PLATFORM_URL =
  "https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x";

const LEGACY_COCKPIT_URLS = [
  "https://fcncvoyreb8p.aiforce.cloud/app/app_17b569zueu9"
];

function platformBaseUrl(config = {}) {
  return String(config.requirementPlatformUrl || DEFAULT_REQUIREMENT_PLATFORM_URL)
    .replace(/\/+$/, "");
}

export function requirementRecordUrl(config, recordId) {
  const base = platformBaseUrl(config);
  return recordId
    ? `${base}/requirements/${encodeURIComponent(recordId)}`
    : `${base}/requirements`;
}

export function iterationRecordUrl(config, iterationId = "") {
  const url = new URL(`${platformBaseUrl(config)}/iterations`);
  if (iterationId) url.searchParams.set("iteration", iterationId);
  return url.toString();
}

function replacementForLegacyBaseUrl(config, rawUrl) {
  try {
    const url = new URL(rawUrl);
    const recordId = url.searchParams.get("record");
    if (recordId) return requirementRecordUrl(config, recordId);
    const tableId = url.searchParams.get("table");
    if (tableId && tableId === config.tables?.iterations) {
      return iterationRecordUrl(config);
    }
    return requirementRecordUrl(config);
  } catch {
    return requirementRecordUrl(config);
  }
}

export function rewriteLegacyNotificationLinks(value, config) {
  let result = String(value || "");
  result = result.replace(
    /https:\/\/[^\s)>\]]+\.feishu\.cn\/base\/[^\s)>\]]+/gi,
    (url) => replacementForLegacyBaseUrl(config, url)
  );
  for (const legacyUrl of LEGACY_COCKPIT_URLS) {
    result = result.replaceAll(legacyUrl, iterationRecordUrl(config));
  }
  return result;
}
