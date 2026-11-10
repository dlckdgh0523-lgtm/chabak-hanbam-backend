import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { ApiError } from './errors';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<{ requestId?: string; method: string; url: string }>();
    const requestId = req.requestId ?? 'n/a';

    if (exception instanceof ApiError) {
      const body = exception.getResponse() as { code: string; message: string; details?: unknown };
      return res.status(exception.getStatus()).json({ ...body, requestId });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const r = exception.getResponse() as string | { message?: string | string[] };
      const message = typeof r === 'string' ? r : Array.isArray(r.message) ? r.message.join('; ') : (r.message ?? exception.message);
      const code =
        status === 400 ? 'VALIDATION_FAILED'
        : status === 401 ? 'UNAUTHENTICATED'
        : status === 403 ? 'FORBIDDEN'
        : status === 404 ? 'NOT_FOUND'
        : 'HTTP_' + status;
      return res.status(status).json({ code, message, requestId, details: typeof r === 'object' ? r : undefined });
    }
    this.log.error(`${req.method} ${req.url} requestId=${requestId}`, (exception as Error)?.stack);
    return res.status(500).json({ code: 'INTERNAL', message: 'internal error', requestId });
  }
}
