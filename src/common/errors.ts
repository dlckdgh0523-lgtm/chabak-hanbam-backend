import { HttpException, HttpStatus } from '@nestjs/common';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNSUPPORTED_CAPABILITY'
  | 'PRECONDITION_FAILED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  UNSUPPORTED_CAPABILITY: 422,
  PRECONDITION_FAILED: 422,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
};

export class ApiError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

// 권한 없는 자원은 존재 여부도 노출하지 않는다 → 소유 검사 실패는 항상 NOT_FOUND
export const notFound = (what = 'resource') => new ApiError('NOT_FOUND', `${what} not found`);
