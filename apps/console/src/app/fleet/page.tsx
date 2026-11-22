import { redirect } from 'next/navigation';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../components/console-header.tsx';
import { decideFleetAction, suspendFleetAction } from '../../server/actions.ts';
import { requireStaff } from '../../server/session.ts';

// Fleet: ownership claims and documents waiting for a decision, and suspensions. Ownership,
// document approval and suspension are separate decisions. Document types are fictional test
// items; the entries are what was typed, not verified documents.

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

interface Claim {
  id: string;
  kind: string;
  category: string;
  equipmentType: string;
  registrationCountry: string;
  registrationNumber: string;
  version: number;
  registeredAt: string;
  suspended: boolean;
  carrier: { id: string; legalName: string };
  otherClaims: { vehicleId: string; ownership: string; carrier: string }[];
}
interface WaitingDocument {
  id: string;
  type: string;
  country: string;
  version: number;
  subject: 'vehicle' | 'driver';
  vehicleId?: string;
  personId?: string;
  registrationNumber?: string;
  driverName?: string;
  documentNumber: string;
  issuingCountry: string;
  issueDate?: string;
  expiryDate: string;
  licenceClasses: string[];
  submittedAt: string;
  carrier: { id: string; legalName: string };
}
interface Suspension {
  id: string;
  subject: 'vehicle' | 'driver';
  vehicleId?: string;
  personId?: string;
  reason: string;
  startedAt: string;
}
interface FleetQueue {
  claims: Claim[];
  documents: WaitingDocument[];
  suspensions: Suspension[];
}

const ERRORS: Record<string, string> = {
  staff_privilege_required:
    'Your account does not hold the privilege this needs. The attempt was recorded.',
  link_not_declared:
    'It is not recorded whether you have a participant account. Until an administrator records your declaration you cannot decide. Nothing was changed.',
  connected:
    'Your declared participant account is connected with this carrier, so you cannot decide about it. Nothing was changed.',
  conflict_not_declared:
    'Tick the declaration that you have no connection with this carrier. Nothing was changed.',
  ownership_conflict:
    'Another claim on this registration is already verified, so this one cannot be verified. Nothing was changed, and the other carrier is not affected.',
  fleet_record_changed: 'The record changed after this page was loaded. Nothing was recorded.',
  fleet_decision_not_open: 'This is no longer waiting for a decision.',
  validation_failed:
    'That was not accepted: choose a decision with its reason, a suspension reason, and note that an expired document cannot be accepted.',
  decision_missing: 'Choose a decision and its reason.',
  not_found: 'That was not found.',
  unconfirmed:
    'It was not confirmed that this was recorded. It may have been. The current state is shown. Recording the same decision again changes nothing twice.',
  refused: 'That was refused.',
};
const DONE: Record<string, string> = {
  decided: 'The decision was recorded.',
  already_decided: 'The decision was recorded.',
  suspension_changed: 'The suspension was changed.',
  suspension_unchanged: 'Nothing needed to change.',
};
const words = (code: string): string => code.replace(/_/g, ' ');

function Decision({
  subject,
  id,
  version,
  choices,
}: {
  subject: 'ownership' | 'document';
  id: string;
  version: number;
  choices: [string, string][];
}) {
  return (
    <form className="form" action={decideFleetAction} data-decide={id}>
      <input type="hidden" name="subject" value={subject} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={version} />
      <div className="field">
        <label htmlFor={`decision-${id}`}>Decision</label>
        <select id={`decision-${id}`} name="decision" defaultValue="">
          <option value="">Choose a decision</option>
          {choices.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="check">
        <input id={`noConflict-${id}`} name="noConflict" type="checkbox" value="yes" />
        <label htmlFor={`noConflict-${id}`}>
          I have no personal or business connection with this carrier or this driver.
        </label>
      </div>
      <button className="button button-primary" type="submit">
        Record the decision
      </button>
    </form>
  );
}

export default async function FleetPage({ searchParams }: Props) {
  const search = await searchParams;
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/fleet" />
        </main>
      </>
    );
  }
  const list = await api<{ fleet: FleetQueue }>('GET', '/staff/fleet', { token: found.token });
  if (!list.ok && list.status === 401) redirect('/sign-in?error=session_ended');
  const error = typeof search.error === 'string' ? (ERRORS[search.error] ?? ERRORS.refused) : null;
  const done = typeof search.done === 'string' ? DONE[search.done] : undefined;
  const admin = found.staff.privileges.includes('staff_admin');
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/fleet" />
      <main id="main" tabIndex={-1}>
        {!list.ok ? (
          list.status === 403 ? (
            <div className="page page-narrow" data-state="forbidden">
              <h1>Fleet</h1>
              <div className="notice notice-error" role="alert" id="forbidden">
                <h2>You cannot see this</h2>
                <p>
                  Fleet records are read by reviewers and administrators. Your account holds neither
                  privilege. This attempt was recorded.
                </p>
              </div>
            </div>
          ) : (
            <Unavailable retryHref="/fleet" />
          )
        ) : (
          <div className="page page-narrow" data-state="fleet">
            <h1>Fleet</h1>
            <p>
              Ownership claims and documents waiting for a decision, oldest first. A registration is
              only a claim until it is verified here. Document types are fictional test items, and
              the entries are what was typed, not verified documents. Opening this page is recorded.
            </p>
            {error ? (
              <div className="notice notice-error" role="alert" id="fleet-error">
                <p>{error}</p>
              </div>
            ) : null}
            {done && !error ? (
              <p className="notice notice-success" role="status" id="fleet-done">
                {done}
              </p>
            ) : null}

            <section className="section" aria-labelledby="claims-title">
              <h2 id="claims-title">Ownership claims</h2>
              {list.data.fleet.claims.length === 0 ? (
                <p id="claims-empty">No claim is waiting.</p>
              ) : (
                <ul className="organisation-list" id="claims">
                  {list.data.fleet.claims.map((claim) => (
                    <li key={claim.id} className="card account" data-claim={claim.id}>
                      <h3>
                        {claim.registrationNumber} ({claim.registrationCountry})
                      </h3>
                      <p>
                        {words(claim.kind)}, {words(claim.category)}, {words(claim.equipmentType)}.
                        Claimed by {claim.carrier.legalName}, {utc(claim.registeredAt)}.
                      </p>
                      {claim.otherClaims.length > 0 ? (
                        <div className="notice" role="note" data-conflict={claim.id}>
                          <p>
                            Other active claims on this registration (shown to staff only; neither
                            carrier is told):
                          </p>
                          <ul>
                            {claim.otherClaims.map((other) => (
                              <li key={other.vehicleId}>
                                {other.carrier}: {other.ownership}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <Decision
                        subject="ownership"
                        id={claim.id}
                        version={claim.version}
                        choices={[
                          [
                            'verified:ownership_evidence_accepted',
                            'Verify: ownership evidence accepted',
                          ],
                          ['rejected:evidence_not_accepted', 'Reject: evidence not accepted'],
                          ['rejected:claim_not_upheld', 'Reject: claim not upheld'],
                        ]}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section" aria-labelledby="documents-title">
              <h2 id="documents-title">Documents</h2>
              {list.data.fleet.documents.length === 0 ? (
                <p id="documents-empty">No document is waiting.</p>
              ) : (
                <ul className="organisation-list" id="documents">
                  {list.data.fleet.documents.map((document) => (
                    <li
                      key={document.id}
                      className="card account"
                      data-document={document.id}
                      data-subject={document.subject}
                    >
                      <h3>
                        {words(document.type)}:{' '}
                        {document.subject === 'vehicle'
                          ? `vehicle ${document.registrationNumber ?? ''}`
                          : `driver ${document.driverName ?? ''}`}
                      </h3>
                      <p>
                        Number {document.documentNumber}, issued in {document.issuingCountry}
                        {document.issueDate ? ` on ${document.issueDate}` : ''}, expires{' '}
                        {document.expiryDate}.
                        {document.licenceClasses.length > 0
                          ? ` Licence classes: ${document.licenceClasses.map(words).join(', ')}.`
                          : ''}{' '}
                        Carrier: {document.carrier.legalName}. Sent {utc(document.submittedAt)}.
                      </p>
                      <p className="field-hint">
                        {document.subject === 'vehicle'
                          ? `Vehicle ${document.vehicleId ?? ''}`
                          : `Driver ${document.personId ?? ''}`}
                      </p>
                      <Decision
                        subject="document"
                        id={document.id}
                        version={document.version}
                        choices={[
                          ['accepted:document_accepted', 'Accept: document accepted'],
                          ['rejected:unreadable', 'Reject: unreadable'],
                          ['rejected:details_mismatch', 'Reject: details do not match'],
                          ['rejected:not_valid', 'Reject: not valid'],
                          ['rejected:not_accepted', 'Reject: not accepted'],
                        ]}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section" aria-labelledby="suspensions-title">
              <h2 id="suspensions-title">Suspensions</h2>
              <p>
                A suspension stops a vehicle or a driver from being eligible at the next check. It
                does not cancel anything by itself. Administrators only.
              </p>
              {list.data.fleet.suspensions.length === 0 ? (
                <p id="suspensions-empty">Nothing is suspended.</p>
              ) : (
                <ul className="evidence" id="suspensions">
                  {list.data.fleet.suspensions.map((item) => (
                    <li key={item.id} data-suspension={item.vehicleId ?? item.personId}>
                      {item.subject} {item.vehicleId ?? item.personId}: {words(item.reason)}, since{' '}
                      {utc(item.startedAt)}
                    </li>
                  ))}
                </ul>
              )}
              {admin ? (
                <form className="form card" id="suspension-form" action={suspendFleetAction}>
                  <div className="field">
                    <label htmlFor="suspension-subject">Vehicle or driver</label>
                    <select id="suspension-subject" name="subject" defaultValue="vehicle">
                      <option value="vehicle">Vehicle</option>
                      <option value="driver">Driver</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="suspension-id">Identifier</label>
                    <p className="field-hint" id="suspension-id-hint">
                      The vehicle or driver identifier shown with its documents above.
                    </p>
                    <input
                      id="suspension-id"
                      name="id"
                      type="text"
                      autoComplete="off"
                      aria-describedby="suspension-id-hint"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="suspension-action">Action</label>
                    <select id="suspension-action" name="suspended" defaultValue="yes">
                      <option value="yes">Suspend</option>
                      <option value="no">End the suspension</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="suspension-reason">Reason (for a suspension)</label>
                    <select id="suspension-reason" name="reason" defaultValue="safety_review">
                      <option value="safety_review">Safety review</option>
                      <option value="document_concern">Document concern</option>
                      <option value="suspected_fraud">Suspected fraud</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <button className="button" type="submit" id="record-suspension">
                    Record
                  </button>
                </form>
              ) : null}
            </section>
          </div>
        )}
      </main>
    </>
  );
}
