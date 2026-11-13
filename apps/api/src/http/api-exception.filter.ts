import { randomUUID } from 'node:crypto';
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { mapError, type ApiErrorBody } from './api-error.js';
import type { Logger } from './logger.js';

interface FilterResponse {
  headersSent: boolean;
  status(code: number): { json(body: unknown): unknown };
}

/** Catches everything and answers with the standard error body. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ requestId?: string }>();
    const response = http.getResponse<FilterResponse>();
    const requestId = request.requestId ?? randomUUID();
    const mapped = mapError(exception);

    if (mapped.status >= 500) {
      // Full detail stays on the server, tied to the identifier the client was given.
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error({
        event: 'unhandled_error',
        requestId,
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
    }
    if (response.headersSent) return;

    const body: ApiErrorBody = {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.details ? { details: mapped.details } : {}),
      requestId,
    };
    response.status(mapped.status).json(body);
  }
}
