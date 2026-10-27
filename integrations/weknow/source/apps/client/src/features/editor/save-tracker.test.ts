import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { trackSave, durabilityProof } from "./save-tracker";
import { saveLabel, SaveState } from "./save-state";
function fixture() {
  const doc = new Y.Doc();
  const listeners = new Map<string, Function>();
  const provider = {
    document: doc,
    configuration: { websocketProvider: { status: "connected" } },
    hasUnsyncedChanges: false,
    on: (key: string, fn: Function) => listeners.set(key, fn),
    off: (key: string) => listeners.delete(key),
  };
  const local = {
    whenSynced: Promise.resolve(),
    db: {
      transaction: () => {
        const tx: any = { objectStore: () => ({ count: () => {} }) };
        queueMicrotask(() => tx.oncomplete?.());
        return tx;
      },
    },
  };
  const states: SaveState[] = [];
  const dispose = trackSave(provider as any, local as any, "test", (s) =>
    states.push(s),
  );
  return { doc, provider, states, dispose, listeners };
}
describe("durable save status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { durable: true } }),
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("shows local persistence before a server receipt, then confirms save", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.states.at(-1)?.phase).toBe("local");
    await vi.advanceTimersByTimeAsync(1800);
    expect(f.states.at(-1)?.phase).toBe("saved");
    f.dispose();
  });
  it("does not claim saved merely because a server accepted the request", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ durable: false }),
    } as any);
    const f = fixture();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.states.at(-1)?.phase).toBe("error");
    expect(f.states.at(-1)?.localSaved).toBe(true);
    f.dispose();
  });
  it("preserves edits and stops retrying after expired authentication", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as any);
    const f = fixture();
    f.doc.getText("test").insert(0, "本地修改");
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.states.at(-1)?.phase).toBe("auth");
    expect(f.doc.getText("test").toString()).toBe("本地修改");
    const count = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetch).toHaveBeenCalledTimes(count);
    f.dispose();
  });
  it("never treats a remote acknowledgement for an older generation as a save for later edits", async () => {
    let finish: any;
    vi.mocked(fetch).mockReturnValue(new Promise((r) => (finish = r)));
    const f = fixture();
    await vi.advanceTimersByTimeAsync(1801);
    f.doc.getText("test").insert(0, "新修改");
    finish({ ok: true, status: 200, json: async () => ({ durable: true }) });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.states.at(-1)?.phase).not.toBe("saved");
    f.dispose();
  });
  it("resumes after a successful login without reloading the document", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as any);
    const f = fixture();
    f.doc.getText("test").insert(0, "保留原文");
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.states.at(-1)?.phase).toBe("auth");
    window.dispatchEvent(new Event("weknow:auth-restored"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.states.at(-1)?.phase).toBe("saved");
    expect(f.doc.getText("test").toString()).toBe("保留原文");
    f.dispose();
  });
  it("times out an unresponsive checkpoint and retries without claiming a save", async () => {
    vi.mocked(fetch).mockImplementationOnce(
      (_, options) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("timeout")),
          ),
        ),
    );
    const f = fixture();
    await vi.advanceTimersByTimeAsync(17000);
    expect(f.states.at(-1)?.phase).toBe("error");
    expect(f.states.at(-1)?.localSaved).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.states.at(-1)?.phase).toBe("saved");
    f.dispose();
  });
  it("includes deletion ranges because Yjs state vectors alone cannot prove deletions", () => {
    const d = new Y.Doc();
    d.getText("text").insert(0, "删除");
    const before = durabilityProof(d);
    d.getText("text").delete(0, 2);
    const after = durabilityProof(d);
    expect(after.stateVector).toBe(before.stateVector);
    expect(after.deleteRanges).toHaveLength(1);
  });
});
