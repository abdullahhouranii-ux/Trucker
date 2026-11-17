import type { INestApplication } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter.js';
import type { Logger } from './logger.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestContext } from './request-id.js';

const NOTIFICATION_LIMIT_BYTES = 64 * 1024;

/**
 * A payment provider's notification is signed over its exact bytes, so its body is read raw
 * and kept as `rawBody`; the JSON parser then leaves it alone. Every other request is untouched.
 */
function rawNotificationBody(
  request: IncomingMessage & { rawBody?: Buffer; body?: unknown; _body?: boolean },
  response: ServerResponse,
  next: (error?: unknown) => void,
): void {
  if (request.method !== 'POST' || !(request.url ?? '').startsWith('/payments/notifications/')) {
    next();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let failed = false;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > NOTIFICATION_LIMIT_BYTES) {
      if (!failed) {
        failed = true;
        response.statusCode = 413;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ code: 'payload_too_large', message: 'The body is too large.' }),
        );
      }
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (failed) return;
    request.rawBody = Buffer.concat(chunks);
    request.body = {};
    request._body = true;
    next();
  });
  request.on('error', (error) => {
    if (!failed) next(error);
  });
}

/**
 * Applies the cross-cutting HTTP behaviour: request identifiers and the standard error body.
 * Call it before the application starts listening, so the identifier is assigned before body
 * parsing and routing and is present on every response, including 404 and parse errors.
 */
export function configureApp<T extends INestApplication>(app: T, logger: Logger): T {
  app.use(requestContext(logger));
  app.use(rawNotificationBody);
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  return app;
}
