/**
 * The one error body returned by the API:
 *   { code, message, details?, requestId }
 * `code` is stable and meant for programs; `message` is for people and may change.
 * Health endpoints are the only exception: they keep their own body because infrastructure
 * reads it.
 */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly requestId: string;
}

/** An error raised on purpose by application code. Its code, status and details are kept. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const STANDARD: Readonly<Record<number, readonly [code: string, message: string]>> = {
  400: ['bad_request', 'The request could not be understood.'],
  401: ['unauthorized', 'Authentication is required.'],
  403: ['forbidden', 'This action is not allowed.'],
  404: ['not_found', 'The requested resource was not found.'],
  405: ['method_not_allowed', 'This method is not allowed here.'],
  409: ['conflict', 'The request conflicts with the current state.'],
  413: ['payload_too_large', 'The request body is too large.'],
  415: ['unsupported_media_type', 'This content type is not supported.'],
  422: ['unprocessable', 'The request was understood but cannot be processed.'],
  429: ['too_many_requests', 'Too many requests. Try again later.'],
  500: ['internal_error', 'An unexpected error occurred.'],
  503: ['service_unavailable', 'The service is temporarily unavailable.'],
};

export interface MappedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { getStatus?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof candidate.getStatus === 'function') {
    const status: unknown = (candidate.getStatus as () => unknown).call(error);
    return typeof status === 'number' ? status : undefined;
  }
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  return undefined;
}

/**
 * Turns anything thrown into what the client may see. Only an ApiError keeps its own text.
 * Framework and library errors are reduced to a standard code and message for their status,
 * so parser messages, paths and internal detail never reach the response. Anything without a
 * client-error status is a 500.
 */
export function mapError(error: unknown): MappedError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  // Raised by the database when the caller's session ended, or a staff privilege was removed,
  // while the request waited for a lock: the whole request was undone (db/migrations/0026).
  const sqlState = (error as { code?: unknown } | null)?.code;
  if (sqlState === 'TR401') {
    const [code, message] = STANDARD[401] as readonly [string, string];
    return { status: 401, code, message };
  }
  if (sqlState === 'TR403')
    return {
      status: 403,
      code: 'staff_privilege_required',
      message: 'Your account does not hold the privilege this needs.',
    };
  const status = statusOf(error);
  if (status !== undefined && status >= 400 && status <= 499) {
    const [code, message] = STANDARD[status] ?? ['request_error', 'The request was not accepted.'];
    return { status, code, message };
  }
  if (status === 503) {
    const [code, message] = STANDARD[503] as readonly [string, string];
    return { status, code, message };
  }
  const [code, message] = STANDARD[500] as readonly [string, string];
  return { status: 500, code, message };
}
