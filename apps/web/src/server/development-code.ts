import 'server-only';
import { headers } from 'next/headers';
import { mayHandleDevelopmentCode, VISITOR_HEADER } from './visitor.ts';

/**
 * Whether this request's visitor may be given a development sign-in code. This is asked once,
 * in the action that requests the code: only then is the API asked for it, and only then is it
 * kept for the visitor. The page that shows the code shows what was kept; it is not asked again
 * there, because Next.js renders that page through a request the server makes to itself, which
 * is rightly classified as forwarded. A visitor who was refused here has nothing to show.
 */
export async function visitorMayHaveDevelopmentCode(): Promise<boolean> {
  const visitor = (await headers()).get(VISITOR_HEADER);
  return mayHandleDevelopmentCode(
    {
      NEXT_PUBLIC_TRUCKER_STAGE: process.env.NEXT_PUBLIC_TRUCKER_STAGE,
      TRUCKER_STAGE: process.env['TRUCKER_STAGE'],
      TRUCKER_DEVELOPMENT_CODE_DISPLAY: process.env['TRUCKER_DEVELOPMENT_CODE_DISPLAY'],
    },
    visitor,
  );
}
