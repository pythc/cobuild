const UNSAFE = /sk-|ghp_|github_pat_|AKIA|ASIA|PRIVATE KEY|Bearer\s+\S+|crsr_|[/\\]/i;

/** Stderr only. Refuses messages that contain paths or secret-shaped text. */
export function diag(message: string): void {
  if (UNSAFE.test(message) || message.length > 180) {
    process.stderr.write('assessment-context-bridge: diagnostic redacted\n');
    return;
  }
  process.stderr.write(`assessment-context-bridge: ${message}\n`);
}

export function safeErrorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  if (!message || UNSAFE.test(message) || message.length > 240) return fallback;
  return message;
}
