import type { Messages } from '../i18n/messages.ts';
import type { PodKind, PodVersion, TripPod } from '../server/api.ts';
import { InstantText } from './booking-view.tsx';
import { Field } from './form.tsx';

// Proof of delivery (slice 18b): what each version holds, which files arrived, and the forms
// each side may use. The driver and the carrier capture; only the shipper's administrators
// review (E-1). A fingerprint is shown as proof that the file arrived unchanged, never as proof
// that the delivery happened (DI-405).

type P = Messages['pod'];
export type PodSide = 'driver' | 'carrier' | 'shipper';

const KINDS: PodKind[] = ['signature', 'signed_document', 'delivery_note', 'cargo_photo', 'other'];
const ACCEPT = 'image/jpeg,image/png,application/pdf';
const utcMinute = (at: Date): string => at.toISOString().slice(0, 16);

function VersionFacts({
  p,
  version,
  fileHref,
  side,
  sendForm,
}: {
  p: P;
  version: PodVersion;
  fileHref: (itemId: string) => string;
  side: PodSide;
  sendForm: (itemId: string) => React.ReactNode;
}) {
  const by =
    version.basis === 'observed'
      ? p.capturedBy
      : (version.enteredAs === 'operations' ? p.byOperations : p.reportedBy).replace(
          '{about}',
          version.about ?? '',
        );
  return (
    <li data-pod-version={version.version} data-pod-state={version.state}>
      <strong>{p.version.replace('{n}', String(version.version))}</strong>:{' '}
      {p.states[version.state]}
      <br />
      <span className="field-hint">
        {by}
        {version.reason
          ? ` (${p.reasons[version.reason as keyof P['reasons']] ?? ''})`
          : null}. {p.capturedAt}: <InstantText at={version.capturedAt} />
      </span>
      {version.receiverName ? (
        <>
          <br />
          {p.receiverName}: <bdi>{version.receiverName}</bdi>
          {version.receiverRole ? (
            <>
              {' '}
              (<bdi>{version.receiverRole}</bdi>)
            </>
          ) : null}
        </>
      ) : null}
      {version.receiverRemarks ? (
        <>
          <br />
          {p.receiverRemarks}: <bdi>{version.receiverRemarks}</bdi>
        </>
      ) : null}
      {version.replacesReason ? (
        <>
          <br />
          {p.replacesReason}: <bdi>{version.replacesReason}</bdi>
        </>
      ) : null}
      {version.review?.note ? (
        <>
          <br />
          {p.reviewNote}: <bdi>{version.review.note}</bdi>
        </>
      ) : null}
      <ul className="evidence">
        {version.items.map((item) => (
          <li key={item.id} data-pod-item={item.kind} data-received={item.received}>
            {p.kinds[item.kind]}
            {item.required ? null : ` (${p.optional})`}:{' '}
            {item.received ? (
              <>
                {p.received}.{' '}
                <a className="button" href={fileHref(item.id)} target="_blank" rel="noopener">
                  {p.open}
                </a>
                <br />
                <span className="field-hint">
                  {p.fingerprint}: <bdi dir="ltr">{item.fingerprint.slice(0, 16)}…</bdi>
                </span>
              </>
            ) : (
              <>
                <strong>{p.missing}</strong>
                {side !== 'shipper' && version.state === 'upload_incomplete'
                  ? sendForm(item.id)
                  : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function PodPanel({
  p,
  pod,
  side,
  hidden,
  fileHref,
  capture,
  send,
  review,
  showCapture,
}: {
  p: P;
  pod: TripPod;
  side: PodSide;
  hidden: React.ReactNode;
  fileHref: (itemId: string) => string;
  capture: (form: FormData) => Promise<void>;
  send: (form: FormData) => Promise<void>;
  review: (form: FormData) => Promise<void>;
  /** Whether a delivery outcome is recorded and the trip is not on hold. */
  showCapture: boolean;
}) {
  const latest = pod.versions.at(-1) ?? null;
  const nextVersion = (latest?.version ?? 0) + 1;
  const canCapture =
    side !== 'shipper' &&
    showCapture &&
    (latest === null ||
      latest.state === 'more_evidence_requested' ||
      latest.state === 'upload_incomplete' ||
      latest.state === 'ready_for_review');
  const onBehalf = side === 'carrier';
  const now = utcMinute(new Date());
  const sendForm = (itemId: string) => (
    <form action={send} className="form-inline">
      {hidden}
      <input type="hidden" name="itemId" value={itemId} />
      <Field id={`pod-send-${itemId}`} label={p.file}>
        <input id={`pod-send-${itemId}`} type="file" name="file" accept={ACCEPT} required />
      </Field>
      <button className="button" type="submit">
        {p.sendMissing}
      </button>
    </form>
  );
  return (
    <section className="card" id="pod" aria-labelledby="pod-title" data-pod={pod.state}>
      <h3 id="pod-title">{p.title}</h3>
      <p id="pod-state">{p.states[pod.state]}</p>
      {pod.versions.length > 0 ? (
        <ul className="evidence" id="pod-versions">
          {[...pod.versions].reverse().map((version) => (
            <VersionFacts
              key={version.id}
              p={p}
              version={version}
              fileHref={fileHref}
              side={side}
              sendForm={sendForm}
            />
          ))}
        </ul>
      ) : null}

      {side === 'shipper' && latest?.state === 'ready_for_review' ? (
        <form action={review} className="form card" id="pod-review">
          {hidden}
          <input type="hidden" name="podId" value={latest.id} />
          <input type="hidden" name="version" value={latest.version} />
          <h4>{p.reviewTitle}</h4>
          <p className="field-hint">{p.reviewLead}</p>
          <Field id="pod-review-note" label={p.reviewNote}>
            <textarea id="pod-review-note" name="note" maxLength={2000} />
          </Field>
          <div className="form-inline">
            <button
              className="button button-primary"
              type="submit"
              name="decision"
              value="accepted"
              data-pod-decision="accepted"
            >
              {p.accept}
            </button>
            <button
              className="button"
              type="submit"
              name="decision"
              value="more_evidence_requested"
              data-pod-decision="more_evidence_requested"
            >
              {p.askMore}
            </button>
          </div>
        </form>
      ) : null}

      {canCapture && (latest === null || latest.state === 'more_evidence_requested') ? (
        <form action={capture} className="form card" id="pod-capture">
          {hidden}
          <input type="hidden" name="version" value={nextVersion} />
          <h4>
            {onBehalf ? p.onBehalfTitle : latest === null ? p.captureTitle : p.newVersionTitle}
          </h4>
          <p className="field-hint">{p.captureLead}</p>
          {KINDS.map((kind) => (
            <Field key={kind} id={`pod-file-${kind}`} label={p.kinds[kind]}>
              <input
                id={`pod-file-${kind}`}
                type="file"
                name={`file-${kind}`}
                accept={ACCEPT}
                multiple={kind === 'cargo_photo' || kind === 'other'}
              />
            </Field>
          ))}
          <Field id="pod-receiver" label={p.receiverName}>
            <input id="pod-receiver" type="text" name="receiverName" maxLength={200} />
          </Field>
          <Field id="pod-receiver-role" label={p.receiverRole}>
            <input id="pod-receiver-role" type="text" name="receiverRole" maxLength={200} />
          </Field>
          <Field id="pod-remarks" label={p.receiverRemarks}>
            <textarea id="pod-remarks" name="receiverRemarks" maxLength={2000} />
          </Field>
          {latest !== null ? (
            <Field id="pod-replaces" label={p.replacesReason}>
              <textarea id="pod-replaces" name="replacesReason" maxLength={1000} required />
            </Field>
          ) : null}
          {onBehalf ? (
            <>
              <Field id="pod-reason" label={p.reason}>
                <select id="pod-reason" name="reason" required defaultValue="paper_copy">
                  {(Object.keys(p.reasons) as (keyof P['reasons'])[]).map((code) => (
                    <option key={code} value={code}>
                      {p.reasons[code]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="pod-captured-at" label={p.capturedAtField}>
                <input
                  id="pod-captured-at"
                  type="datetime-local"
                  name="capturedAt"
                  defaultValue={now}
                  max={now}
                  required
                />
              </Field>
              <Field id="pod-note" label={p.note}>
                <textarea id="pod-note" name="note" maxLength={1000} />
              </Field>
            </>
          ) : null}
          <button className="button button-primary" type="submit" data-pod-capture="true">
            {p.send}
          </button>
        </form>
      ) : null}
    </section>
  );
}
