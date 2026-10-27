import * as Y from "yjs";
import type { IndexeddbPersistence } from "y-indexeddb";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { SaveState } from "./save-state";

export function durabilityProof(doc: Y.Doc) {
  const deletes = Y.decodeUpdate(Y.encodeStateAsUpdate(doc)).ds.clients;
  return {
    stateVector: btoa(String.fromCharCode(...Y.encodeStateVector(doc))),
    deleteRanges: [...deletes].flatMap(([client, ranges]) =>
      ranges.map((r) => ({ client, clock: r.clock, len: r.len })),
    ),
  };
}

export function trackSave(
  provider: HocuspocusProvider,
  local: IndexeddbPersistence,
  pageId: string,
  emit: (s: SaveState) => void,
) {
  let disposed = false,
    generation = 0,
    localGeneration = -1,
    confirmedGeneration = -1,
    authFailed = false,
    permissionFailed = false,
    pending = false;
  let localError = false,
    remoteError = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  function publish() {
    if (disposed) return;
    const localSaved = localGeneration === generation;
    const connected =
      provider.configuration.websocketProvider.status === "connected" &&
      navigator.onLine;
    const phase = permissionFailed
      ? "permission"
      : authFailed
        ? "auth"
        : localError
          ? "error"
          : !connected
            ? "offline"
            : confirmedGeneration === generation
              ? "saved"
              : remoteError
                ? "error"
                : localSaved
                  ? "local"
                  : "saving";
    emit({ pageId, phase, localSaved });
  }
  async function localCheckpoint() {
    const target = generation;
    try {
      await local.whenSynced;
      if (disposed || !local.db) return;
      // This transaction is queued after y-indexeddb's update transaction.
      // Its completion acknowledges a committed local write, not just initial hydration.
      await new Promise<void>((resolve, reject) => {
        const tx = local.db!.transaction("updates", "readonly");
        tx.objectStore("updates").count();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      localGeneration = target;
      localError = false;
    } catch {
      localError = true;
    }
    publish();
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void checkpoint(), 1800);
  }
  async function checkpoint() {
    if (
      disposed ||
      pending ||
      authFailed ||
      permissionFailed ||
      !navigator.onLine
    )
      return;
    if (
      provider.configuration.websocketProvider.status !== "connected" ||
      provider.hasUnsyncedChanges
    ) {
      schedule();
      return;
    }
    pending = true;
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    controller.signal.addEventListener("abort", abortRequest, { once: true });
    const requestTimeout = setTimeout(abortRequest, 15000);
    const target = generation;
    try {
      const response = await fetch("/api/review/checkpoint", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: requestController.signal,
        body: JSON.stringify({ pageId, ...durabilityProof(provider.document) }),
      });
      if ([401, 403].includes(response.status)) {
        authFailed = true;
        permissionFailed = response.status === 403;
        return;
      }
      if (!response.ok) throw new Error("Checkpoint unavailable");
      const raw = await response.json(),
        data = raw.data ?? raw;
      if (data.durable) {
        confirmedGeneration = target;
        remoteError = false;
      } else remoteError = true;
    } catch {
      if (!disposed) remoteError = true;
    } finally {
      clearTimeout(requestTimeout);
      controller.signal.removeEventListener("abort", abortRequest);
      pending = false;
      publish();
      if (!disposed && confirmedGeneration !== generation && !authFailed) {
        timer = setTimeout(() => void checkpoint(), 10000);
      }
    }
  }
  const update = () => {
    generation++;
    remoteError = false;
    publish();
    void localCheckpoint();
    schedule();
  };
  const status = () => {
    publish();
    schedule();
  };
  const failed = ({ reason }: { reason: string }) => {
    authFailed = reason !== "identity-unavailable";
    publish();
  };
  const expired = () => {
    authFailed = true;
    publish();
  };
  const permissionChanged = () => {
    permissionFailed = true;
    publish();
  };
  const restored = () => {
    authFailed = false;
    publish();
    schedule();
  };
  const authenticated = () => {
    authFailed = false;
    permissionFailed = false;
    publish();
    schedule();
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (localGeneration !== generation && confirmedGeneration !== generation) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  provider.document.on("update", update);
  provider.on("status", status);
  provider.on("synced", status);
  provider.on("authenticationFailed", failed);
  provider.on("authenticated", authenticated);
  window.addEventListener("weknow:auth-expired", expired);
  window.addEventListener("weknow:auth-restored", restored);
  window.addEventListener("weknow:permission-changed", permissionChanged);
  window.addEventListener("online", status);
  window.addEventListener("offline", status);
  window.addEventListener("beforeunload", unload);
  void localCheckpoint();
  schedule();
  return () => {
    emit({ pageId: "", phase: "loading", localSaved: false });
    disposed = true;
    controller.abort();
    clearTimeout(timer);
    provider.document.off("update", update);
    provider.off("status", status);
    provider.off("synced", status);
    provider.off("authenticationFailed", failed);
    provider.off("authenticated", authenticated);
    window.removeEventListener("weknow:auth-expired", expired);
    window.removeEventListener("weknow:auth-restored", restored);
    window.removeEventListener("weknow:permission-changed", permissionChanged);
    window.removeEventListener("online", status);
    window.removeEventListener("offline", status);
    window.removeEventListener("beforeunload", unload);
  };
}
