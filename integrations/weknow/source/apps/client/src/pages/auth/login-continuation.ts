const KEY = "110lab:sso-attempt";
export function beginAutomaticLogin(search: string, storage: Pick<Storage, "getItem" | "setItem">, now = Date.now()): boolean {
  const params = new URLSearchParams(search);
  if (params.has("error") || params.has("logout")) return false;
  try {
    const previous = Number(storage.getItem(KEY));
    if (previous > 0 && now - previous < 90_000) return false;
    storage.setItem(KEY, String(now));
    return true;
  } catch { return false; }
}
export function clearAutomaticLogin(storage: Pick<Storage, "removeItem">) {
  try { storage.removeItem(KEY); } catch { /* Restricted browser storage keeps manual login available. */ }
}
