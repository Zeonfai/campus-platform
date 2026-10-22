import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { ApiErrorBody } from '@campus/contracts';

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const details = exception instanceof HttpException ? exception.getResponse() : undefined;
    const item =
      typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {};
    const codes: Record<number, string> = {
      400: 'VALIDATION_FAILED',
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'RESOURCE_CONFLICT',
      422: 'INVALID_STATE',
      429: 'RATE_LIMITED',
      500: 'INTERNAL_ERROR',
      501: 'NOT_IMPLEMENTED',
      503: 'DEPENDENCY_UNAVAILABLE',
    };
    const body: ApiErrorBody = {
      error: {
        code: typeof item.code === 'string' ? item.code : (codes[status] ?? 'REQUEST_FAILED'),
        message:
          status === 500
            ? 'Internal request failure'
            : typeof item.message === 'string'
              ? item.message
              : 'Request rejected',
        traceId: String(response.getHeader('x-request-id') ?? randomUUID()),
      },
    };
    response.status(status).json(body);
  }
}
