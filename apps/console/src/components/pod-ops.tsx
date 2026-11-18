import type { TripPod } from '../../../web/src/server/api.ts';
import { operationsPodAction } from '../server/operations-actions.ts';

// Proof of delivery for operations (slice 18b): every version and file, each file opened through
// the console (each view recorded, AT-415), and a paper copy uploaded on the driver's behalf.
// Operations never accepts a POD on the shipper's behalf (E-1).

const at = (value: string): string => `${value.slice(0, 16).replace('T', ' ')} UTC`;
const STATES: Record<string, string> = {
  not_received: 'No proof of delivery has arrived',
  upload_incomplete: 'Started: required files missing',
  ready_for_review: 'Ready for the shipper to review',
  accepted: 'Accepted by the shipper',
  more_evidence_requested: 'The shipper asked for more evidence',
  superseded: 'Replaced by a newer version',
};
const KINDS: Record<string, string> = {
  signature: "Receiver's signature",
  signed_document: 'Signed and stamped document',
  delivery_note: 'Delivery note',
  cargo_photo: 'Photo of the cargo',
  other: 'Other evidence',
};
const REASONS: Record<string, string> = {
  paper_copy: 'A paper copy was handed in',
  device_lost: "The driver's phone was lost",
  no_phone: 'The driver has no phone',
  no_signal: 'No signal',
  driver_unable: 'The driver could not do it',
  other: 'Other (say why in the note)',
};

export function PodOpsPanel({
  bookingId,
  pod,
  now,
}: {
  bookingId: string;
  pod: TripPod;
  now: string;
}) {
  const latest = pod.versions.at(-1) ?? null;
  const canUpload = latest === null || latest.state === 'more_evidence_requested';
  return (
    <section className="section" id="pod" aria-labelledby="pod-title">
      <h2 id="pod-title">Proof of delivery</h2>
      <p data-pod={pod.state}>{STATES[pod.state]}. Only the shipper accepts it.</p>
      <ul className="evidence" id="ops-pod-versions">
        {[...pod.versions].reverse().map((version) => (
          <li key={version.id} data-pod-version={version.version}>
            Version {version.version}: {STATES[version.state]}; captured {at(version.capturedAt)}{' '}
            {version.basis === 'observed' ? 'by the driver' : `on behalf (${version.enteredAs})`}
            {version.review?.note ? (
              <>
                ; asked: <bdi>{version.review.note}</bdi>
              </>
            ) : null}
            <ul className="evidence">
              {version.items.map((item) => (
                <li key={item.id}>
                  {KINDS[item.kind]}
                  {item.required ? '' : ' (optional)'}:{' '}
                  {item.received ? (
                    <a
                      className="button"
                      href={`/operations/bookings/${bookingId}/pod/${item.id}`}
                      target="_blank"
                      rel="noopener"
                    >
                      Open (the view is recorded)
                    </a>
                  ) : (
                    'not received'
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {canUpload ? (
        <form className="form card" action={operationsPodAction} id="ops-pod-form">
          <input type="hidden" name="bookingId" value={bookingId} />
          <input type="hidden" name="version" value={(latest?.version ?? 0) + 1} />
          <h3>Upload a paper proof on the driver&apos;s behalf</h3>
          {Object.entries(KINDS).map(([kind, label]) => (
            <div className="field" key={kind}>
              <label htmlFor={`ops-pod-${kind}`}>{label}</label>
              <input
                id={`ops-pod-${kind}`}
                type="file"
                name={`file-${kind}`}
                accept="image/jpeg,image/png,application/pdf"
                multiple={kind === 'cargo_photo' || kind === 'other'}
              />
            </div>
          ))}
          <div className="field">
            <label htmlFor="ops-pod-receiver">Receiver&apos;s name</label>
            <input id="ops-pod-receiver" type="text" name="receiverName" maxLength={200} />
          </div>
          {latest !== null ? (
            <div className="field">
              <label htmlFor="ops-pod-replaces">Why this replaces the earlier version</label>
              <textarea id="ops-pod-replaces" name="replacesReason" rows={2} maxLength={1000} />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="ops-pod-reason">Reason</label>
            <select id="ops-pod-reason" name="reason">
              {Object.entries(REASONS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ops-pod-at">When it was captured (UTC)</label>
            <input
              id="ops-pod-at"
              type="datetime-local"
              name="capturedAt"
              defaultValue={now}
              max={now}
            />
          </div>
          <div className="field">
            <label htmlFor="ops-pod-note">Note (operations and the carrier)</label>
            <textarea id="ops-pod-note" name="note" rows={2} maxLength={1000} />
          </div>
          <button className="button" type="submit" id="ops-pod-upload">
            Upload
          </button>
        </form>
      ) : null}
    </section>
  );
}
