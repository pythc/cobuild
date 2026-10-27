export const IDENTITY_UNAVAILABLE = "identity-unavailable";

// The document stays in the provider/Yjs store. Retry the handshake, never replay
// an HTTP write or construct a replacement document from a stale snapshot.
export class CollabAuthRetry {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private disposed = false;

  constructor(private readonly retry: () => void) {}

  failed(reason: string) {
    if (reason !== IDENTITY_UNAVAILABLE) {
      this.reset();
      return;
    }
    if (this.disposed || this.timer) return;
    const delay = Math.min(2_000 * 2 ** Math.min(this.attempts++, 4), 30_000);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (!this.disposed) this.retry();
      },
      delay + Math.floor(Math.random() * 500),
    );
  }

  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.attempts = 0;
  }

  dispose() {
    this.disposed = true;
    this.reset();
  }
}
