import { randomUUID } from 'node:crypto';
export function countWritingCharacters(text: string): number {
  return Array.from(text.replace(/\s/gu, '')).length;
}
export function writingWeek(now = new Date()) {
  const offset = 8 * 3600_000;
  const local = new Date(now.getTime() + offset);
  const start =
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() - ((local.getUTCDay() + 6) % 7),
    ) - offset;
  return { start: new Date(start), end: new Date(start + 7 * 86400_000) };
}
export interface WritingChunk {
  id: string;
  userId: string;
  bucket: Date;
  charsDelta: number;
}
export class WritingBuffer {
  private readonly lengths = new Map<string, number>();
  private readonly chunks = new Map<string, Map<string, WritingChunk>>();
  loaded(name: string, text: string) {
    this.lengths.set(name, countWritingCharacters(text));
  }
  changed(
    name: string,
    userId: string | undefined,
    text: string,
    at = Date.now(),
  ) {
    const size = countWritingCharacters(text),
      previous = this.lengths.get(name);
    this.lengths.set(name, size);
    // No actor or baseline means no trustworthy attribution (loading/replication).
    if (!userId || previous === undefined) return;
    const bucket = Math.floor(at / 300_000) * 300_000,
      key = userId + ':' + bucket;
    const entries = this.chunks.get(name) || new Map<string, WritingChunk>();
    const row = entries.get(key) || {
      id: randomUUID(),
      userId,
      bucket: new Date(bucket),
      charsDelta: 0,
    };
    row.charsDelta += size - previous;
    entries.set(key, row);
    this.chunks.set(name, entries);
  }
  take(name: string): WritingChunk[] {
    const rows = [...(this.chunks.get(name)?.values() || [])];
    this.chunks.delete(name);
    return rows;
  }
  restore(name: string, rows: WritingChunk[]) {
    const entries = this.chunks.get(name) || new Map<string, WritingChunk>();
    // Keep IDs stable after an uncertain commit. The DB insert is idempotent.
    for (const row of rows) entries.set('retry:' + row.id, row);
    this.chunks.set(name, entries);
  }
  unloaded(name: string) {
    this.lengths.delete(name);
    this.chunks.delete(name);
  }
}
