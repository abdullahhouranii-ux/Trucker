import { disputeEvidenceProxy } from '../../../../../../web/src/server/dispute-evidence.ts';
import { staffToken } from '../../../../server/session.ts';

export async function GET(request: Request, { params }: { params: Promise<{ ids: string[] }> }) {
  return disputeEvidenceProxy(request, (await params).ids, await staffToken(), true);
}

export const PUT = GET;
