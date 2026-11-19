export class AppError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'AppError'; }
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: 'The operation failed. Inspect the recorded outcome before retrying.' };
}
