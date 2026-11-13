import { randomUUID } from 'node:crypto';
import type { Logger } from './logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Letters, digits, dot, underscore and hyphen; 8 to 128 characters. Anything else is replaced. */
const ACCEPTABLE = /^[A-Za-z0-9._-]{8,128}$/;

export function resolveRequestId(inbound: unknown): string {
  return typeof inbound === 'string' && ACCEPTABLE.test(inbound) ? inbound : randomUUID();
}

interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
  originalUrl?: string;
  requestId?: string;
}

interface OutgoingResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: 'finish', listener: () => void): unknown;
}

/**
 * First middleware in the chain. Gives every request an identifier, returns it in the
 * X-Request-Id header of every response, and writes one log line when the response is sent.
 * The log line holds method, path without query string, status and duration: no headers,
 * no body, no query values.
 */
export function requestContext(logger: Logger) {
  return (request: IncomingRequest, response: OutgoingResponse, next: () => void): void => {
    const requestId = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    const startedAt = process.hrtime.bigint();
    response.on('finish', () => {
      logger.info({
        event: 'request',
        requestId,
        method: request.method,
        path: (request.originalUrl ?? request.url).split('?')[0],
        status: response.statusCode,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      });
    });
    next();
  };
}
