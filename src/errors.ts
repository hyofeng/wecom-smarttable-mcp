export class WecomError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export function failure(error: unknown) {
  return error instanceof WecomError
    ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
    : { code: 'INTERNAL_ERROR', message: '本地操作失败；未返回底层错误，以免泄露登录凭据。' };
}

export function requireData(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WecomError('PARSE_ERROR', message);
}
