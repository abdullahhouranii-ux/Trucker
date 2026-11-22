import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../web/src/components/form.tsx';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../components/console-header.tsx';
import { draftFinancialAction, moveFinancialAction } from '../../server/actions.ts';
import { requireStaff } from '../../server/session.ts';

// Financial settings (db/migrations/0022). One administrator drafts a version with a reason
// and an effective time; a different administrator approves it. Approved versions are never
// changed: a version not yet in effect can be withdrawn, and a new one drafted. Each booking
// records the version in force when it was accepted.

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

interface Person {
  id: string;
  displayName: string;
}
interface Setting {
  id: string;
  versionNo: number;
  version: number;
  status: string;
  state: 'draft' | 'in_force' | 'scheduled' | 'superseded' | 'discarded' | 'withdrawn';
  developmentDefault: boolean;
  feeBasisPoints: number;
  commissionOptions: string[];
  commissionMaxBasisPoints: number;
  commissionSettlementMaxDays: number;
  freightDueDays: number;
  note: string;
  effectiveFrom: string | null;
  effectiveAt: string | null;
  draftedBy: Person | null;
  draftedAt: string;
  approvedBy: Person | null;
  approvedAt: string | null;
  closedBy: Person | null;
  closedAt: string | null;
}
interface Overview {
  now: string;
  inForce: Setting;
  versions: Setting[];
}

const DONE: Record<string, string> = {
  drafted: 'The draft was saved. It changes nothing until a different administrator approves it.',
  already_drafted: 'This draft was already saved. Nothing more was made.',
  approved: 'The version was approved. It applies from its effective time.',
  already_approved: 'You had already approved this version.',
  discarded: 'The draft was discarded.',
  already_discarded: 'This draft was already discarded.',
  withdrawn: 'The version was withdrawn. It will not take effect.',
  already_withdrawn: 'This version was already withdrawn.',
};
const ERRORS: Record<string, string> = {
  staff_privilege_required: 'Your account does not hold the privilege this needs.',
  different_person_required: 'You drafted this version. A different administrator must approve it.',
  effective_time_passed:
    'The effective time of this draft has passed. Discard it and draft it again.',
  version_in_effect:
    'This version is already in effect and cannot be withdrawn. Draft a new version instead.',
  version_not_open: 'This version is no longer open for that.',
  record_changed: 'The version changed since the page was loaded. Nothing was changed.',
  retry_key_conflict: 'This form was used for a different draft. Reload the page.',
  not_found: 'That version was not found.',
  unconfirmed:
    'It was not confirmed that this was done. It may have been. The list shows the present state. Trying again changes nothing twice.',
  refused: 'That was refused.',
};
const FIELDS: Record<string, [string, string]> = {
  feeBasisPoints: [
    'feeBasisPoints',
    "Trucker's fee: a whole number of basis points from 0 to 5000.",
  ],
  commissionOptions: ['option-percentage', 'Commission options: choose from the three listed.'],
  commissionMaxBasisPoints: [
    'commissionMaxBasisPoints',
    'Commission limit: a whole number of basis points from 1 to 5000.',
  ],
  commissionSettlementMaxDays: [
    'commissionSettlementMaxDays',
    'Longest commission settlement period: from 1 to 365 days.',
  ],
  freightDueDays: ['freightDueDays', 'Freight due: from 0 to 365 days.'],
  note: ['note', 'Reason: say why this change is made.'],
  effectiveFrom: ['effectiveDate', 'Effective time: a date and time in UTC, later than now.'],
};
const STATE: Record<Setting['state'], string> = {
  draft: 'Draft, waiting for approval',
  in_force: 'In force',
  scheduled: 'Approved, takes effect later',
  superseded: 'Superseded',
  discarded: 'Discarded',
  withdrawn: 'Withdrawn',
};
const OPTIONS: [string, string][] = [
  ['percentage', 'A percentage of the shipping price'],
  ['fixed', 'A fixed amount'],
  ['contract', 'A contract with each carrier'],
];
const percent = (points: number): string => `${(points / 100).toFixed(2)}%`;

function Values({ setting, id }: { setting: Setting; id?: string }) {
  return (
    <ul className="evidence" id={id}>
      <li>
        Trucker&apos;s fee: {setting.feeBasisPoints} basis points ({percent(setting.feeBasisPoints)}
        ) of the shipping price, rounded half-up
      </li>
      <li>
        Commission options:{' '}
        {setting.commissionOptions.length === 0
          ? 'none'
          : setting.commissionOptions
              .map((option) => OPTIONS.find(([code]) => code === option)?.[1] ?? option)
              .join('; ')}
      </li>
      <li>
        Commission limit: {setting.commissionMaxBasisPoints} basis points (
        {percent(setting.commissionMaxBasisPoints)})
      </li>
      <li>Longest commission settlement period: {setting.commissionSettlementMaxDays} days</li>
      <li>Freight due: {setting.freightDueDays} days</li>
    </ul>
  );
}

export default async function FinancePage({ searchParams }: Props) {
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/finance" />
        </main>
      </>
    );
  }
  const search = await searchParams;
  const one = (name: string): string =>
    typeof search[name] === 'string' ? (search[name] as string) : '';
  const reply = await api<{ settings: Overview }>('GET', '/staff/financial-settings', {
    token: found.token,
  });
  if (!reply.ok && reply.status === 401) redirect('/sign-in?error=session_ended');
  const done = DONE[one('done')];
  const error = one('error');
  const problems =
    error === 'validation_failed'
      ? one('fields')
          .split(',')
          .filter((code) => code !== '')
          .map((code) => {
            const entry = FIELDS[code.split(':')[0] ?? ''];
            return entry ? { field: entry[0], message: entry[1] } : { message: ERRORS.refused! };
          })
      : error !== ''
        ? [{ message: ERRORS[error] ?? ERRORS.refused! }]
        : [];
  const retry = /^[A-Za-z0-9._-]{16,128}$/.test(one('retry')) ? one('retry') : randomUUID();
  const me = found.staff.id;
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/finance" />
      <main id="main" tabIndex={-1}>
        <div className="page" data-state="finance">
          <h1>Financial settings</h1>
          <p>
            Every change is drafted by one administrator, with its reason and its effective time,
            and approved by a different administrator. An approved version is never changed. Each
            booking records the version in force when it was accepted, and later versions never
            change it. Times are in UTC.
          </p>
          <ErrorSummary title="This was not done" problems={problems} />
          {done && problems.length === 0 ? (
            <p className="notice notice-success" role="status" id="finance-done">
              {done}
            </p>
          ) : null}
          {!reply.ok ? (
            <div className="notice notice-error" role="alert" id="finance-unavailable">
              {reply.status === 403
                ? 'Your account does not hold the privilege this needs. The attempt was recorded.'
                : 'This could not be read. Reload the page.'}
            </div>
          ) : (
            <>
              <section
                className="section"
                aria-labelledby="in-force-title"
                id="in-force"
                data-setting={reply.data.settings.inForce.id}
                data-fee={reply.data.settings.inForce.feeBasisPoints}
                data-default={String(reply.data.settings.inForce.developmentDefault)}
              >
                <h2 id="in-force-title">
                  In force now: version {reply.data.settings.inForce.versionNo}
                </h2>
                {reply.data.settings.inForce.developmentDefault ? (
                  <p className="notice" role="note" id="development-default">
                    This is the development default, not approved for production. A production start
                    is refused until an approved version is in force.
                  </p>
                ) : null}
                <Values setting={reply.data.settings.inForce} />
              </section>

              <section className="section" aria-labelledby="draft-title">
                <h2 id="draft-title">Draft a new version</h2>
                <p>
                  The form starts from the version in force. A draft changes nothing until another
                  administrator approves it.
                </p>
                <form className="form card" id="draft-form" action={draftFinancialAction}>
                  <input type="hidden" name="retryKey" value={retry} />
                  <div className="field">
                    <label htmlFor="feeBasisPoints">Trucker&apos;s fee, in basis points</label>
                    <p className="field-hint" id="feeBasisPoints-hint">
                      Of the shipping price. 100 basis points are 1%. From 0 to 5000.
                    </p>
                    <input
                      id="feeBasisPoints"
                      name="feeBasisPoints"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      aria-describedby="feeBasisPoints-hint"
                      defaultValue={reply.data.settings.inForce.feeBasisPoints}
                    />
                  </div>
                  <fieldset className="choice">
                    <legend>Commission options organisers may choose</legend>
                    {OPTIONS.map(([code, label]) => (
                      <label key={code}>
                        <input
                          id={`option-${code}`}
                          name={`option-${code}`}
                          type="checkbox"
                          defaultChecked={reply.data.settings.inForce.commissionOptions.includes(
                            code,
                          )}
                        />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                  <div className="field">
                    <label htmlFor="commissionMaxBasisPoints">
                      Commission limit, in basis points
                    </label>
                    <p className="field-hint" id="commissionMaxBasisPoints-hint">
                      The highest percentage an organiser may set. From 1 to 5000.
                    </p>
                    <input
                      id="commissionMaxBasisPoints"
                      name="commissionMaxBasisPoints"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      aria-describedby="commissionMaxBasisPoints-hint"
                      defaultValue={reply.data.settings.inForce.commissionMaxBasisPoints}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="commissionSettlementMaxDays">
                      Longest commission settlement period, in days
                    </label>
                    <p className="field-hint" id="commissionSettlementMaxDays-hint">
                      The most days a commission contract may allow for payment. From 1 to 365.
                    </p>
                    <input
                      id="commissionSettlementMaxDays"
                      name="commissionSettlementMaxDays"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      aria-describedby="commissionSettlementMaxDays-hint"
                      defaultValue={reply.data.settings.inForce.commissionSettlementMaxDays}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="freightDueDays">Freight due, in days</label>
                    <p className="field-hint" id="freightDueDays-hint">
                      Days the freight payer has to pay the carrier. From 0 to 365.
                    </p>
                    <input
                      id="freightDueDays"
                      name="freightDueDays"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      aria-describedby="freightDueDays-hint"
                      defaultValue={reply.data.settings.inForce.freightDueDays}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="note">Reason for the change</label>
                    <textarea id="note" name="note" rows={3} maxLength={1000} />
                  </div>
                  <fieldset className="choice">
                    <legend>When it takes effect</legend>
                    <label>
                      <input
                        id="effective-approval"
                        name="effective"
                        type="radio"
                        value="approval"
                        defaultChecked
                      />
                      When it is approved
                    </label>
                    <label>
                      <input
                        id="effective-scheduled"
                        name="effective"
                        type="radio"
                        value="scheduled"
                      />
                      At the date and time below (UTC)
                    </label>
                  </fieldset>
                  <div className="field">
                    <label htmlFor="effectiveDate">Date, in UTC (only for a set time)</label>
                    <input
                      id="effectiveDate"
                      name="effectiveDate"
                      type="text"
                      inputMode="numeric"
                      maxLength={10}
                      placeholder="YYYY-MM-DD"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="effectiveTime">Time, in UTC (only for a set time)</label>
                    <input
                      id="effectiveTime"
                      name="effectiveTime"
                      type="text"
                      inputMode="numeric"
                      maxLength={5}
                      placeholder="HH:MM"
                    />
                  </div>
                  <button className="button button-primary" type="submit" id="draft-setting">
                    Save the draft
                  </button>
                </form>
              </section>

              <section className="section" aria-labelledby="versions-title">
                <h2 id="versions-title">All versions</h2>
                <ol className="organisation-list" id="versions">
                  {reply.data.settings.versions.map((item) => (
                    <li
                      className="card"
                      key={item.id}
                      data-setting={item.id}
                      data-state={item.state}
                    >
                      <h3>
                        Version {item.versionNo}: {STATE[item.state]}
                        {item.developmentDefault ? ' (development default)' : ''}
                      </h3>
                      <Values setting={item} />
                      <p>Reason: {item.note}</p>
                      <ul className="evidence">
                        {item.draftedBy ? (
                          <li>
                            Drafted by {item.draftedBy.displayName}
                            {item.draftedBy.id === me ? ' (you)' : ''} on {utc(item.draftedAt)}
                          </li>
                        ) : null}
                        {item.approvedBy && item.approvedAt ? (
                          <li>
                            Approved by {item.approvedBy.displayName}
                            {item.approvedBy.id === me ? ' (you)' : ''} on {utc(item.approvedAt)}
                          </li>
                        ) : null}
                        {item.effectiveAt ? (
                          <li>Effective from {utc(item.effectiveAt)}</li>
                        ) : item.state === 'draft' ? (
                          <li>
                            Takes effect{' '}
                            {item.effectiveFrom
                              ? `at ${utc(item.effectiveFrom)}`
                              : 'when it is approved'}
                          </li>
                        ) : null}
                        {item.closedBy && item.closedAt ? (
                          <li>
                            {item.state === 'withdrawn' ? 'Withdrawn' : 'Discarded'} by{' '}
                            {item.closedBy.displayName} on {utc(item.closedAt)}
                          </li>
                        ) : null}
                      </ul>
                      {item.state === 'draft' || item.state === 'scheduled' ? (
                        <form className="form-inline" action={moveFinancialAction}>
                          <input type="hidden" name="settingId" value={item.id} />
                          <input type="hidden" name="version" value={item.version} />
                          {item.state === 'draft' ? (
                            <>
                              <button
                                className="button button-primary"
                                type="submit"
                                name="move"
                                value="approve"
                                data-move="approve"
                              >
                                Approve version {item.versionNo}
                              </button>
                              <button
                                className="button"
                                type="submit"
                                name="move"
                                value="discard"
                                data-move="discard"
                              >
                                Discard version {item.versionNo}
                              </button>
                            </>
                          ) : (
                            <button
                              className="button button-danger"
                              type="submit"
                              name="move"
                              value="withdraw"
                              data-move="withdraw"
                            >
                              Withdraw version {item.versionNo}
                            </button>
                          )}
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
