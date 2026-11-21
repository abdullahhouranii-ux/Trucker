import { api, apiGetFile, apiPutFile } from '../../../../../server/api.ts';
import { sessionToken } from '../../../../../server/session.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limit = 10 * 1024 * 1024;
type Context = { params: Promise<{ ids: string[] }> };

export async function GET(request: Request, context: Context) {
  const parts = await context.params;
  const [org, kind, record, photo] = parts.ids;
  if (
    !org ||
    !record ||
    !uuid.test(org) ||
    !uuid.test(record) ||
    !['shipments', 'vehicles'].includes(kind ?? '') ||
    (photo !== undefined && !uuid.test(photo)) ||
    parts.ids.length > 4
  )
    return new Response(null, { status: 404 });
  const token = await sessionToken();
  if (!token) return new Response(null, { status: 401 });
  const path = '/organisations/' + org + '/' + kind + '/' + record + '/photos';

  if (request.method === 'PUT') {
    if (!photo) return new Response(null, { status: 404 });
    if (request.headers.get('sec-fetch-site') !== 'same-origin')
      return new Response(null, { status: 403 });
    const mediaType = request.headers.get('content-type') ?? '';
    if (!['image/jpeg', 'image/png'].includes(mediaType))
      return new Response(null, { status: 415 });
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 422 });
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(new Uint8Array(value));
    }
    const reply = await apiPutFile(path + '/' + photo, {
      token,
      mediaType,
      retryKey: photo,
      bytes: await new Blob(chunks).arrayBuffer(),
    });
    return new Response(null, { status: reply.ok ? 204 : reply.status || 503 });
  }
  if (photo) {
    const file = await apiGetFile(path + '/' + photo, token);
    if (!file || file.status !== 200) return new Response(null, { status: file?.status || 503 });
    return new Response(file.bytes, {
      headers: {
        'content-type': file.type,
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
      },
    });
  }
  const result = await api<{ photos: { id: string }[] }>('GET', path, { token });
  return result.ok
    ? Response.json(result.data, { headers: { 'cache-control': 'private, no-store' } })
    : new Response(null, { status: result.status || 503 });
}
export const PUT = GET;
