// Cache only a successful central session inspection, never roles or permissions.
// Local user, directory and session checks still run on every request.
export class IdentityInspectionCache {
  private readonly entries = new Map<
    string,
    { fingerprint: string; until: number; pending?: Promise<void> }
  >();

  constructor(
    private readonly ttlMs = 15_000,
    private readonly capacity = 1_000,
  ) {}

  async verify(
    key: string,
    fingerprint: string,
    expiresAt: number,
    inspect: () => Promise<number | void>,
  ): Promise<void> {
    const now = Date.now();
    const previous = this.entries.get(key);
    if (previous?.fingerprint === fingerprint) {
      if (previous.pending) return previous.pending;
      if (previous.until > now && expiresAt > now) return;
    }
    const entry = {
      fingerprint,
      until: 0,
      pending: undefined as Promise<void>,
    };
    // Bound memory, including invalid/revoked sessions. In-flight callers retain
    // their own promise even if an entry is evicted.
    this.entries.delete(key);
    if (this.entries.size >= this.capacity)
      this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, entry);
    const started = Date.now();
    entry.pending = Promise.resolve()
      .then(inspect)
      .then((inspectedExpiry) => {
        // Count TTL from the start, not the completion of a slow request.
        entry.until = Math.min(
          started + this.ttlMs,
          expiresAt,
          typeof inspectedExpiry === 'number' ? inspectedExpiry : Infinity,
        );
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      })
      .finally(() => {
        entry.pending = undefined;
      });
    return entry.pending;
  }
}
