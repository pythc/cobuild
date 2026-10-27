import { HttpException } from '@nestjs/common';

// Only fixed stages are logged. Never log callback URLs, query parameters,
// cookies, credentials, response bodies or exception messages from providers.
export class IdentityLoginError extends HttpException {
  constructor(
    public readonly stage: string,
    status = 401,
  ) {
    super('Identity login failed', status);
  }
}
export async function identityLoginStep<T>(
  stage: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new IdentityLoginError(
      stage,
      error instanceof HttpException ? error.getStatus() : 500,
    );
  }
}
