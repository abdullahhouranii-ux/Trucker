import { randomUUID } from 'node:crypto';
import type { TripCargo } from '../../../web/src/server/api.ts';
import { operationsCargoAction } from '../server/operations-actions.ts';

// Undeliverable cargo for Trucker operations (slice 18d, R-406). Operations documents and
// coordinates: it records what a competent authority ordered, a receipt the receiving side
// gave, and a final liability only from its source (the contract, a settlement or a competent
// decision). It never decides liability itself, and nothing here moves money.

const at = (value: string): string => `${value.slice(0, 16).replace('T', ' ')} UTC`;

const ACTIONS: Record<string, string> = {
  retry_delivery: 'Try delivery again',
  alternate_destination: 'Deliver to another destination',
  temporary_storage: 'Store temporarily',
  return_to_sender: 'Return to the sender',
  return_destination: 'Return to another approved place',
};
const STATES: Record<string, string> = {
  requested: 'waiting for the carrier',
  offered: 'offered, waiting for approval',
  approved: 'approved',
  executing: 'being carried out',
  completed: 'completed',
  failed: 'could not be completed',
  declined: 'declined',
  not_feasible: 'not feasible',
  withdrawn: 'withdrawn',
};
const REASONS: Record<string, string> = {
  wrong_address: 'Wrong address',
  receiver_absent: 'Receiver absent',
  site_not_ready: 'Site not ready',
  site_closed: 'Site closed',
  receiver_refused: 'Receiver refused',
  cargo_damaged: 'Cargo damaged',
  document_problem: 'Problem with documents',
  carrier_delay: 'Carrier delay',
  other: 'Other',
};
const LIABILITY: Record<string, string> = {
  contracting_customer: 'The contracting customer',
  organiser: 'The organiser',
  carrier: 'The carrier',
  shared: 'Shared',
  other: 'Another party',
};
const SOURCES: Record<string, string> = {
  contract: 'The contract',
  settlement: 'A settlement between the parties',
  competent_decision: 'A competent decision',
};

function SourceFields({ prefix }: { prefix: string }) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${prefix}-source`}>Source</label>
        <select id={`${prefix}-source`} name="source">
          {Object.entries(SOURCES).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-reference`}>Reference (clause, settlement or decision)</label>
        <input type="text" id={`${prefix}-reference`} name="reference" maxLength={500} />
      </div>
    </>
  );
}

export function CargoOpsPanel({
  bookingId,
  cargo,
  retryKey,
}: {
  bookingId: string;
  cargo: TripCargo;
  /** The key of a command whose answer never arrived, to send it again unchanged. */
  retryKey: string | null;
}) {
  const k = cargo.case;
  if (!k) return null;
  const key = () => retryKey ?? randomUUID();
  const hidden = (command: string) => (
    <>
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="anchor" value="cargo" />
      <input type="hidden" name="command" value={command} />
      <input type="hidden" name="retryKey" value={key()} />
    </>
  );
  const open = k.closedAt === null;
  const costs = k.instructions.flatMap((item) => item.costs ?? []);
  const openInstruction = k.instructions.some((item) =>
    ['requested', 'offered', 'approved', 'executing'].includes(item.state),
  );
  return (
    <section className="section" id="cargo" aria-labelledby="cargo-title">
      <h2 id="cargo-title">Cargo not delivered</h2>
      <ul className="evidence" id="ops-cargo-summary">
        {k.shortfall ? (
          <li>
            {REASONS[k.shortfall.reason] ?? k.shortfall.reason}: delivered{' '}
            <bdi>
              {k.shortfall.quantityDelivered} {k.shortfall.quantityUnit}
            </bdi>
            , not delivered{' '}
            <bdi>
              {k.shortfall.quantityRemaining} {k.shortfall.quantityUnit}
            </bdi>
            , at <bdi>{k.shortfall.location}</bdi>
          </li>
        ) : null}
        <li data-on-vehicle={String(cargo.onVehicle)}>
          Still on the vehicle: <bdi>{String(cargo.onVehicle)}</bdi>
        </li>
        <li>
          Instructions due by {at(k.responseDueAt)}; escalation at {at(k.escalateAt)}
          {k.escalatedAt ? ` (escalated ${at(k.escalatedAt)})` : ''}
        </li>
        {k.authorityOrder ? (
          <li>
            Competent authority: <bdi>{k.authorityOrder}</bdi>. Allowed:{' '}
            {(k.authorityAllowedActions ?? []).map((code) => ACTIONS[code]).join(', ') || 'none'}
          </li>
        ) : null}
        {k.closedAt ? <li>Closed {at(k.closedAt)}</li> : null}
      </ul>

      <h3>Who may instruct</h3>
      <ul className="evidence">
        {(cargo.authorities ?? []).length === 0 ? <li>Nobody yet.</li> : null}
        {(cargo.authorities ?? []).map((item) => (
          <li key={item.id}>
            {item.holderRole === 'organiser' ? 'Organiser by mandate' : 'Contracting customer'} (
            <bdi>{item.holder ?? ''}</bdi>): {item.actions.map((code) => ACTIONS[code]).join(', ')};
            limit{' '}
            <bdi>
              {item.spendLimit} {item.currency}
            </bdi>
            {item.endedAt ? `; ended ${at(item.endedAt)}` : ''}
            {item.alternateContact ? (
              <>
                ; alternate contact <bdi>{item.alternateContact}</bdi>
              </>
            ) : null}
          </li>
        ))}
      </ul>

      <h3>Instructions and costs</h3>
      <ul className="evidence" id="ops-cargo-instructions">
        {k.instructions.length === 0 ? <li>No instruction yet.</li> : null}
        {k.instructions.map((item) => (
          <li key={item.id} data-state={item.state}>
            {ACTIONS[item.action]}: {STATES[item.state]}
            {item.emergency ? ' (protective action under the emergency plan)' : ''}
            {item.approvedTotal ? `; approved total ${item.approvedTotal}` : ''}
            {(item.costs ?? []).map((cost) => (
              <div key={cost.id} data-cost={cost.id}>
                {cost.kind}: <bdi>{cost.quantity}</bdi> {cost.unit} ×{' '}
                <bdi>
                  {cost.unitAmount} = {cost.amount} {cost.currency}
                </bdi>
                ; pays for now: {cost.interimPayer}; final:{' '}
                {cost.finalLiability
                  ? `${LIABILITY[cost.finalLiability] ?? cost.finalLiability} (${SOURCES[cost.finalSource ?? ''] ?? ''}: ${cost.finalReference ?? ''})`
                  : cost.provisionalLiability === 'per_contract'
                    ? 'as the contract says, not recorded'
                    : 'not decided'}
                {cost.held ? '; held' : ''}
              </div>
            ))}
          </li>
        ))}
      </ul>

      {k.handovers.length > 0 ? (
        <>
          <h3>Handovers</h3>
          <ul className="evidence">
            {k.handovers.map((item) => (
              <li key={item.id} data-receipt={item.receipt?.state ?? 'pending'}>
                <bdi>
                  {String(item.quantity ?? '')} {item.quantityUnit ?? ''}
                </bdi>{' '}
                from <bdi>{item.handedBy}</bdi> to <bdi>{item.receivedBy}</bdi> at{' '}
                <bdi>{item.place}</bdi>, {at(item.handedAt)}:{' '}
                {item.receipt
                  ? `${item.receipt.state} (${item.receipt.reference})`
                  : 'not confirmed by the receiving side'}
                {item.receipt === null ? (
                  <form className="form" action={operationsCargoAction}>
                    {hidden('confirm_receipt')}
                    <input type="hidden" name="handoverId" value={item.id} />
                    <div className="field">
                      <label htmlFor={`receipt-${item.id}`}>
                        Receipt reference given by the receiving side
                      </label>
                      <input
                        type="text"
                        id={`receipt-${item.id}`}
                        name="reference"
                        maxLength={500}
                      />
                    </div>
                    <div className="form-inline">
                      <button className="button" type="submit" name="state" value="confirmed">
                        Record it confirmed
                      </button>
                      <button className="button" type="submit" name="state" value="rejected">
                        Record it rejected
                      </button>
                    </div>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {costs.some((cost) => cost.finalLiability === null) ? (
        <form className="form card" action={operationsCargoAction} id="ops-liability">
          {hidden('record_liability')}
          <h3>Record the final liability from its source</h3>
          <p>
            Only what the contract, a settlement or a competent decision says. Trucker does not
            decide it.
          </p>
          <div className="field">
            <label htmlFor="ops-liability-cost">Cost</label>
            <select id="ops-liability-cost" name="costId">
              {costs
                .filter((cost) => cost.finalLiability === null)
                .map((cost) => (
                  <option key={cost.id} value={cost.id}>
                    {cost.kind} {cost.amount} {cost.currency}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ops-liability-party">Who bears it</label>
            <select id="ops-liability-party" name="liability">
              {Object.entries(LIABILITY).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <SourceFields prefix="ops-liability" />
          <button className="button" type="submit">
            Record the liability
          </button>
        </form>
      ) : null}

      {(k.claims ?? []).length > 0 ? (
        <>
          <h3>Claims</h3>
          <ul className="evidence">
            {(k.claims ?? []).map((claim) => (
              <li key={claim.id} data-claim={claim.state}>
                <bdi>{claim.description}</bdi>: {claim.state}
                {claim.state === 'open' ? (
                  <form className="form" action={operationsCargoAction}>
                    {hidden('decide_claim')}
                    <input type="hidden" name="claimId" value={claim.id} />
                    <div className="field">
                      <label htmlFor={`claim-${claim.id}`}>Decision, from its source</label>
                      <select id={`claim-${claim.id}`} name="decision">
                        <option value="upheld">Upheld</option>
                        <option value="partly_upheld">Partly upheld</option>
                        <option value="rejected">Rejected</option>
                      </select>
                    </div>
                    <SourceFields prefix={`claim-${claim.id}`} />
                    <button className="button" type="submit">
                      Record the decision
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {(k.holds ?? []).length > 0 ? (
        <>
          <h3>Holds</h3>
          <ul className="evidence">
            {(k.holds ?? []).map((hold) => (
              <li key={hold.id} data-hold={hold.ownerKind}>
                {hold.ownerKind === 'carrier_claim' ? 'For a claim' : 'For a cost dispute'}:{' '}
                {hold.costIds.length} cost(s)
                {hold.releasedAt ? `, released ${at(hold.releasedAt)}` : ''}
                {hold.releasedAt === null ? (
                  <form className="form" action={operationsCargoAction}>
                    {hidden('release_hold')}
                    <input type="hidden" name="holdId" value={hold.id} />
                    <div className="field">
                      <label htmlFor={`hold-${hold.id}`}>Why it is released</label>
                      <textarea id={`hold-${hold.id}`} name="note" rows={2} maxLength={2000} />
                    </div>
                    <button className="button" type="submit">
                      Release this hold
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {open && !k.authorityOrder ? (
        <form className="form card" action={operationsCargoAction} id="ops-authority-order">
          {hidden('authority_order')}
          <h3>Record a competent authority&apos;s instruction</h3>
          <p>
            Once recorded, only the actions it allows can be instructed; an open one outside it
            stops.
          </p>
          <div className="field">
            <label htmlFor="ops-order">What the authority ordered</label>
            <textarea id="ops-order" name="order" rows={2} maxLength={2000} />
          </div>
          <fieldset className="choice">
            <legend>Actions it allows</legend>
            {Object.entries(ACTIONS).map(([code, label]) => (
              <label key={code}>
                <input type="checkbox" name="allowedActions" value={code} /> {label}
              </label>
            ))}
          </fieldset>
          <button className="button" type="submit">
            Record the instruction
          </button>
        </form>
      ) : null}

      {open && !openInstruction ? (
        <form className="form card" action={operationsCargoAction} id="ops-close-case">
          {hidden('close_case')}
          <h3>Close the cargo case</h3>
          <p>Closing releases no hold and no resource.</p>
          <div className="field">
            <label htmlFor="ops-close-note">Why it is closed</label>
            <textarea id="ops-close-note" name="note" rows={2} maxLength={2000} />
          </div>
          <button className="button" type="submit">
            Close the case
          </button>
        </form>
      ) : null}
    </section>
  );
}
