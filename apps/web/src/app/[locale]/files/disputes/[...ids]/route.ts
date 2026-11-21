import { disputeEvidenceProxy } from '../../../../../server/dispute-evidence.ts';
import { sessionToken } from '../../../../../server/session.ts';

export async function GET(request: Request, { params }: { params: Promise<{ ids: string[] }> }) {
  return disputeEvidenceProxy(request, (await params).ids, await sessionToken(), false);
}

export const PUT = GET;
