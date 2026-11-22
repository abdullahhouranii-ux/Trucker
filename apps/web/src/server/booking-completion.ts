import 'server-only';
import { api } from './api.ts';

export async function sendCompletion(
  path: string,
  token: string | undefined,
  key: string,
  body: Record<string, unknown>,
) {
  if (!token) return 'refused';
  const result = await api('POST', path, { token, retryKey: key, body });
  if (result.ok) return 'ok';
  if (result.status === 0 || result.status >= 500 || result.code === 'unavailable')
    return 'unknown';
  return result.status === 409 ? 'conflict' : 'refused';
}
