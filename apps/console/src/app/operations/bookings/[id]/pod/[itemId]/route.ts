import { apiGetFile } from '../../../../../../../../web/src/server/api.ts';
import { staffToken } from '../../../../../../server/session.ts';

// A proof-of-delivery file for operations. The API records every view (AT-415); this server
// passes the file through and keeps nothing.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  const { id, itemId } = await context.params;
  if (!UUID.test(id) || !UUID.test(itemId)) return new Response('Not found', { status: 404 });
  const token = await staffToken();
  if (!token) return new Response('Sign in to see this file', { status: 401 });
  const file = await apiGetFile(`/staff/operations/bookings/${id}/pod/items/${itemId}/file`, token);
  if (file === null) return new Response('The file cannot be read now', { status: 503 });
  if (file.status !== 200)
    return new Response(file.status === 403 ? 'Operations privilege needed' : 'Not found', {
      status: file.status === 403 ? 403 : 404,
    });
  return new Response(file.bytes, {
    status: 200,
    headers: {
      'content-type': file.type,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
      'content-disposition':
        file.type === 'application/pdf' ? 'attachment; filename="proof-of-delivery.pdf"' : 'inline',
    },
  });
}
