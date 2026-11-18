import { apiGetFile } from '../../../../../../server/api.ts';
import { sessionToken } from '../../../../../../server/session.ts';

// A proof-of-delivery file, read through the API as the signed-in person (slice 18b). The API
// decides who may read it (a party to the booking); this server never stores or caches it.
// `?org=` names the organisation the person acts for; without it, the person acts as the driver.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ bookingId: string; itemId: string }> },
): Promise<Response> {
  const { bookingId, itemId } = await context.params;
  const org = new URL(request.url).searchParams.get('org') ?? '';
  const notFound = () => new Response('Not found', { status: 404 });
  if (!UUID.test(bookingId) || !UUID.test(itemId) || (org !== '' && !UUID.test(org)))
    return notFound();
  const token = await sessionToken();
  if (!token) return new Response('Sign in to see this file', { status: 401 });
  const path =
    org === ''
      ? `/me/driver/assignments/${bookingId}/pod/items/${itemId}/file`
      : `/organisations/${org}/bookings/${bookingId}/pod/items/${itemId}/file`;
  const file = await apiGetFile(path, token);
  if (file === null) return new Response('The file cannot be read now', { status: 503 });
  if (file.status !== 200) return notFound();
  return new Response(file.bytes, {
    status: 200,
    headers: {
      'content-type': file.type,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
      // A PDF is downloaded rather than shown in a sandboxed page, where viewers refuse it.
      'content-disposition':
        file.type === 'application/pdf' ? 'attachment; filename="proof-of-delivery.pdf"' : 'inline',
    },
  });
}
