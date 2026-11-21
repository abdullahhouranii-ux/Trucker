import 'server-only';
import { apiGetFile, apiPutFile } from './api.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limit = 10 * 1024 * 1024;

export async function disputeEvidenceProxy(
  request: Request,
  ids: string[],
  token: string | undefined,
  staff: boolean,
) {
  const org = new URL(request.url).searchParams.get('org') ?? '';
  const [booking, dispute, evidence] = ids;
  const upload = request.method === 'PUT';
  if (
    !booking ||
    !dispute ||
    !uuid.test(booking) ||
    !uuid.test(dispute) ||
    (!staff && !uuid.test(org)) ||
    ids.length !== (upload ? 2 : 3) ||
    (!upload && !/^[1-9]\d{0,18}$/.test(evidence ?? ''))
  ) {
    return new Response(null, { status: 404 });
  }
  if (!token) return new Response(null, { status: 401 });
  const root = staff ? '/staff/operations' : `/organisations/${org}`;
  const path = `${root}/bookings/${booking}/disputes/${dispute}/evidence`;
  if (upload) {
    if (request.headers.get('sec-fetch-site') !== 'same-origin')
      return new Response(null, { status: 403 });
    const retryKey = request.headers.get('idempotency-key') ?? '';
    if (!/^[A-Za-z0-9._-]{16,128}$/.test(retryKey)) return new Response(null, { status: 422 });
    const mediaType = request.headers.get('content-type') ?? '';
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(mediaType))
      return new Response(null, { status: 415 });
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 422 });
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      parts.push(new Uint8Array(value));
    }
    const reply = await apiPutFile(path, {
      token,
      retryKey,
      mediaType,
      bytes: await new Blob(parts).arrayBuffer(),
    });
    return new Response(null, { status: reply.ok ? 204 : reply.status || 503 });
  }
  const file = await apiGetFile(`${path}/${evidence}`, token);
  if (!file || file.status !== 200) return new Response(null, { status: file?.status || 503 });
  return new Response(file.bytes, {
    headers: {
      'content-type': file.type,
      'content-disposition': 'attachment',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}
