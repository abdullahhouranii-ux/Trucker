import 'server-only';

// Calls to the Trucker API, made only from the web server. The browser never talks to the API
// and never holds the session token: it is kept in an HttpOnly cookie on this application.
const base = (): string => process.env.TRUCKER_API_URL ?? 'http://localhost:3000';

export type ApiReply<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; details: Record<string, unknown> };

export async function api<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: {
    body?: unknown;
    token?: string;
    retryKey?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiReply<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.retryKey) headers['idempotency-key'] = options.retryKey;
  let response: Response;
  try {
    response = await fetch(base() + path, {
      method,
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, code: 'unavailable', details: {} };
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, status: response.status, code: 'unavailable', details: {} };
  }
  if (response.ok) return { ok: true, status: response.status, data: parsed as T };
  const body = parsed as { code?: unknown; details?: unknown };
  return {
    ok: false,
    status: response.status,
    code: typeof body.code === 'string' ? body.code : 'unavailable',
    details:
      typeof body.details === 'object' && body.details !== null
        ? (body.details as Record<string, unknown>)
        : {},
  };
}

export interface Person {
  id: string;
  phoneMasked: string;
  displayName: string | null;
  contactEmail: string | null;
  registrationComplete: boolean;
}
export interface Session {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}
export interface Terms {
  kind: 'demonstration';
  version: string;
  language: string;
  title: string;
  notice: string;
  paragraphs: string[];
}
