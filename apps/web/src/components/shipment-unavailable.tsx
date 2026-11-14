import { ErrorSummary, type Problem } from './form.tsx';
import type { Messages } from '../i18n/messages.ts';
import type { ApiReply } from '../server/api.ts';

/** Shown when the server did not answer or the data is closed here. Nothing is claimed. */
export function ShipmentUnavailable({
  m,
  reply,
  problems,
  retryHref,
  backHref,
}: {
  m: Messages;
  reply: ApiReply<unknown> | undefined;
  problems: Problem[];
  retryHref: string;
  backHref: string;
}) {
  const t = m.ship;
  const message =
    reply && !reply.ok && reply.code === 'organisation_access_closed'
      ? t.errors.organisation_access_closed
      : t.errors.shipment_unavailable;
  return (
    <div className="page page-narrow" data-state="shipments-unavailable">
      <h1>{t.unavailableTitle}</h1>
      <ErrorSummary title={m.auth.errors.summary} problems={[...problems, { message }]} />
      <div className="form-inline">
        <a className="button" id="retry-shipments" href={retryHref}>
          {t.retry}
        </a>
        <a className="button" href={backHref}>
          {t.backToOrganisation}
        </a>
      </div>
    </div>
  );
}
