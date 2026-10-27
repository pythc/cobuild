export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}
