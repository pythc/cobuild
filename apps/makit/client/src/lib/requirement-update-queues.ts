export const requirementUpdateQueues = new Map<string, Promise<void>>();

export async function waitForRequirementUpdates(
  signal: AbortSignal,
): Promise<void> {
  while (requirementUpdateQueues.size) {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void =>
        reject(new DOMException('读取已取消', 'AbortError'));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      void Promise.allSettled([...requirementUpdateQueues.values()]).then(
        () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
      );
    });
  }
  if (signal.aborted) throw new DOMException('读取已取消', 'AbortError');
}
