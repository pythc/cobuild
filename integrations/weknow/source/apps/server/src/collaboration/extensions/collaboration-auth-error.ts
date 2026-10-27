// This reason is a protocol marker, not a user/session identifier.
export const IDENTITY_UNAVAILABLE = 'identity-unavailable';

export function isTemporaryAuthFailure(error: unknown): boolean {
  const status =
    typeof (error as any)?.getStatus === 'function'
      ? (error as any).getStatus()
      : undefined;
  // Unknown infrastructure failures are unavailable, never a grant to continue.
  return status === undefined || status === 429 || status >= 500;
}

export function temporaryAuthError() {
  return Object.assign(new Error('Identity temporarily unavailable'), {
    code: 1013,
    reason: IDENTITY_UNAVAILABLE,
  });
}
