import type { Messages } from '../i18n/messages.ts';
import type {
  CargoAction,
  CargoCost,
  CargoInstruction,
  CostKind,
  ShortfallReason,
  TripCargo,
} from '../server/api.ts';
import { InstantText } from './booking-view.tsx';
import { Field } from './form.tsx';

// Undeliverable or refused cargo (slice 18d, R-406). Three things are kept apart on this page:
// who may instruct, who approved a cost and pays it for now, and who finally bears it. Only the
// first two are recorded by the parties; the last comes from the contract, a settlement or a
// competent decision, recorded by Trucker operations. Nothing here moves money.

type C = Messages['cargo'];
export type CargoSide = 'shipper' | 'organiser' | 'carrier' | 'driver';

export const CARGO_ACTIONS: CargoAction[] = [
  'retry_delivery',
  'alternate_destination',
  'temporary_storage',
  'return_to_sender',
  'return_destination',
];
export const SHORTFALL_REASONS: ShortfallReason[] = [
  'wrong_address',
  'receiver_absent',
  'site_not_ready',
  'site_closed',
  'receiver_refused',
  'cargo_damaged',
  'document_problem',
  'carrier_delay',
  'other',
];
const COST_KINDS: CostKind[] = [
  'waiting',
  'handling',
  'unloading',
  'storage',
  'retry',
  'alternate_transport',
  'return',
  'other',
];
const UNITS = ['hour', 'day', 'trip', 'item', 'lump_sum'] as const;
const OPEN = ['requested', 'offered', 'approved', 'executing'];
const utcMinute = (at: Date): string => at.toISOString().slice(0, 16);

/** The hidden fields every cargo form sends: who is asking, about what, and its retry key. */
function Hidden({
  hidden,
  command,
  retryKey,
  version,
}: {
  hidden: React.ReactNode;
  command: string;
  retryKey: () => string;
  version?: number;
}) {
  return (
    <>
      {hidden}
      <input type="hidden" name="command" value={command} />
      <input type="hidden" name="retryKey" value={retryKey()} />
      {version === undefined ? null : <input type="hidden" name="version" value={version} />}
    </>
  );
}

function Costs({ c, costs, side }: { c: C; costs: CargoCost[]; side: CargoSide }) {
  if (costs.length === 0) return <p className="field-hint">{c.costsNone}</p>;
  return (
    <table className="table">
      <caption className="visually-hidden">{c.costsTitle}</caption>
      <thead>
        <tr>
          <th scope="col">{c.kind}</th>
          <th scope="col">{c.quantity}</th>
          <th scope="col">{c.unitAmount}</th>
          <th scope="col">{c.total}</th>
          <th scope="col">{c.interimPayer}</th>
          <th scope="col">{c.liability}</th>
        </tr>
      </thead>
      <tbody>
        {costs.map((cost) => (
          <tr key={cost.id} data-cost={cost.kind}>
            <td>
              {c.kinds[cost.kind]}
              {cost.description ? (
                <>
                  <br />
                  <bdi className="field-hint">{cost.description}</bdi>
                </>
              ) : null}
              {cost.held && side !== 'driver' ? (
                <>
                  {' '}
                  <strong data-held="true">({c.held})</strong>
                </>
              ) : null}
            </td>
            <td>
              <bdi>{cost.quantity}</bdi> {c.units[cost.unit]}
            </td>
            <td>
              <bdi>
                {cost.unitAmount} {cost.currency}
              </bdi>
            </td>
            <td>
              <bdi>
                {cost.amount} {cost.currency}
              </bdi>
            </td>
            <td>{c.interimPayers[cost.interimPayer]}</td>
            <td>
              {cost.finalLiability ? (
                <bdi>
                  {cost.finalLiability} ({cost.finalReference})
                </bdi>
              ) : cost.provisionalLiability === 'per_contract' ? (
                `${c.provisional.per_contract}. ${c.liabilityPending}`
              ) : (
                c.liabilityPending
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CostFields({ c, prefix }: { c: C; prefix: string }) {
  return (
    <>
      {[0, 1, 2].map((n) => (
        <fieldset key={n} className="fieldset">
          <legend>{c.costLine.replace('{n}', String(n + 1))}</legend>
          <Field id={`${prefix}-cost${n}-kind`} label={c.kind}>
            <select id={`${prefix}-cost${n}-kind`} name={`cost${n}Kind`} defaultValue="">
              <option value="">—</option>
              {COST_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {c.kinds[kind]}
                </option>
              ))}
            </select>
          </Field>
          <Field id={`${prefix}-cost${n}-quantity`} label={c.quantity}>
            <input
              type="text"
              id={`${prefix}-cost${n}-quantity`}
              name={`cost${n}Quantity`}
              inputMode="decimal"
              maxLength={12}
            />
          </Field>
          <Field id={`${prefix}-cost${n}-unit`} label={c.unit}>
            <select id={`${prefix}-cost${n}-unit`} name={`cost${n}Unit`} defaultValue="lump_sum">
              {UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {c.units[unit]}
                </option>
              ))}
            </select>
          </Field>
          <Field id={`${prefix}-cost${n}-amount`} label={c.unitAmount}>
            <input
              type="text"
              id={`${prefix}-cost${n}-amount`}
              name={`cost${n}UnitAmount`}
              inputMode="decimal"
              maxLength={16}
            />
          </Field>
          <Field id={`${prefix}-cost${n}-description`} label={c.description}>
            <input
              type="text"
              id={`${prefix}-cost${n}-description`}
              name={`cost${n}Description`}
              maxLength={500}
            />
          </Field>
        </fieldset>
      ))}
    </>
  );
}

function InstructionItem({
  c,
  item,
  side,
  forms,
}: {
  c: C;
  item: CargoInstruction;
  side: CargoSide;
  forms: React.ReactNode;
}) {
  return (
    <li data-instruction={item.action} data-state={item.state}>
      <strong>{c.actions[item.action]}</strong>: {c.states[item.state]}
      {item.emergency ? (
        <>
          {' '}
          <span className="field-hint">({c.emergencyTag})</span>
        </>
      ) : null}
      <br />
      <span className="field-hint">
        {item.issuer ? `${c.issuedBy} ${item.issuer}, ` : null}
        <InstantText at={item.issuedAt} />
      </span>
      {item.destination ? (
        <>
          <br />
          {c.destination}: <bdi>{item.destination}</bdi>
        </>
      ) : null}
      {item.details ? (
        <>
          <br />
          {c.details}: <bdi>{item.details}</bdi>
        </>
      ) : null}
      {item.offerEta ? (
        <>
          <br />
          {c.eta}: <InstantText at={item.offerEta} />
        </>
      ) : null}
      {item.offerNote ? (
        <>
          <br />
          {c.offerNote}: <bdi>{item.offerNote}</bdi>
        </>
      ) : null}
      {item.executionNote ? (
        <>
          <br />
          {c.executionNote}: <bdi>{item.executionNote}</bdi>
        </>
      ) : null}
      {item.costs && side !== 'driver' && item.state !== 'requested' ? (
        <Costs c={c} costs={item.costs} side={side} />
      ) : null}
      {forms}
    </li>
  );
}

/**
 * What a party sees of undeliverable cargo, and the forms its side may use. `canInstruct`
 * says whether the organiser holds an authority in force; the server checks again either way.
 */
export function CargoPanel({
  c,
  cargo,
  side,
  hidden,
  action,
  retryKey,
  canInstruct,
}: {
  c: C;
  cargo: TripCargo;
  side: CargoSide;
  hidden: React.ReactNode;
  action: (form: FormData) => Promise<void>;
  retryKey: () => string;
  canInstruct: boolean;
}) {
  const k = cargo.case;
  if (!k) return null;
  const open = k.closedAt === null;
  const instructing = side === 'shipper' || (side === 'organiser' && canInstruct);
  const current = k.instructions.find((item) => OPEN.includes(item.state)) ?? null;
  const authorities = cargo.authorities ?? [];
  const now = utcMinute(new Date());
  const allCosts = k.instructions.flatMap((item) => item.costs ?? []);
  const disputable = allCosts.filter((cost) => !cost.held && cost.finalLiability === null);

  const instructionForms = (item: CargoInstruction): React.ReactNode => {
    if (!open || item !== current) return null;
    const forms: React.ReactNode[] = [];
    if (instructing && (item.state === 'requested' || item.state === 'offered'))
      forms.push(
        <form key="withdraw" action={action} className="form-inline">
          <Hidden hidden={hidden} command="withdraw" retryKey={retryKey} version={item.version} />
          <input type="hidden" name="instructionId" value={item.id} />
          <button className="button" type="submit" data-cargo="withdraw">
            {c.withdraw}
          </button>
        </form>,
      );
    if (instructing && item.state === 'offered')
      forms.push(
        <form key="decide" action={action} className="form card" id="cargo-decide">
          <Hidden hidden={hidden} command="decide" retryKey={retryKey} version={item.version} />
          <input type="hidden" name="instructionId" value={item.id} />
          <p className="field-hint">{c.approveLead}</p>
          <Field id="cargo-interim" label={c.interimPayer}>
            <select id="cargo-interim" name="interimPayer" defaultValue="instructing_party">
              <option value="instructing_party">{c.interimPayers.instructing_party}</option>
              <option value="carrier">{c.interimPayers.carrier}</option>
            </select>
          </Field>
          <div className="form-inline">
            <button
              className="button button-primary"
              type="submit"
              name="decision"
              value="approve"
              data-cargo="approve"
            >
              {c.approve}
            </button>
            <button className="button" type="submit" name="decision" value="decline">
              {c.decline}
            </button>
          </div>
        </form>,
      );
    if (side === 'carrier' && item.state === 'requested')
      forms.push(
        <form key="offer" action={action} className="form card" id="cargo-offer">
          <Hidden hidden={hidden} command="offer" retryKey={retryKey} version={item.version} />
          <input type="hidden" name="instructionId" value={item.id} />
          <h4>{c.offerTitle}</h4>
          <p className="field-hint">{c.offerLead}</p>
          <fieldset className="fieldset">
            <legend>{c.feasible}</legend>
            <div className="check">
              <input
                type="radio"
                id="cargo-feasible-yes"
                name="feasible"
                value="yes"
                defaultChecked
              />
              <label htmlFor="cargo-feasible-yes">{c.yes}</label>
            </div>
            <div className="check">
              <input type="radio" id="cargo-feasible-no" name="feasible" value="no" />
              <label htmlFor="cargo-feasible-no">{c.no}</label>
            </div>
          </fieldset>
          <Field id="cargo-eta" label={c.eta}>
            <input id="cargo-eta" name="eta" type="datetime-local" min={now} />
          </Field>
          <Field id="cargo-offer-note" label={c.offerNote}>
            <textarea id="cargo-offer-note" name="note" maxLength={2000} />
          </Field>
          <CostFields c={c} prefix="offer" />
          <button className="button button-primary" type="submit" data-cargo="offer">
            {c.offer}
          </button>
        </form>,
      );
    if (side === 'carrier' && (item.state === 'approved' || item.state === 'executing'))
      forms.push(
        <form key="execute" action={action} className="form card" id="cargo-execute">
          <Hidden hidden={hidden} command="execute" retryKey={retryKey} version={item.version} />
          <input type="hidden" name="instructionId" value={item.id} />
          {item.state === 'executing' ? (
            <Field id="cargo-execution-note" label={c.executionNote}>
              <textarea id="cargo-execution-note" name="note" maxLength={2000} />
            </Field>
          ) : null}
          <div className="form-inline">
            {item.state === 'approved' ? (
              <button
                className="button button-primary"
                type="submit"
                name="step"
                value="start"
                data-cargo="start"
              >
                {c.start}
              </button>
            ) : (
              <>
                <button
                  className="button button-primary"
                  type="submit"
                  name="step"
                  value="complete"
                  data-cargo="complete"
                >
                  {c.complete}
                </button>
                <button className="button" type="submit" name="step" value="fail">
                  {c.fail}
                </button>
              </>
            )}
          </div>
        </form>,
      );
    return forms.length > 0 ? <>{forms}</> : null;
  };

  return (
    <section className="card" id="cargo" aria-labelledby="cargo-title" data-cargo-case={k.id}>
      <h3 id="cargo-title">{c.title}</h3>
      <p className="field-hint">{side === 'driver' ? c.driverLead : c.lead}</p>
      {k.shortfall ? (
        <dl className="facts" id="cargo-shortfall">
          <dt>{c.reason}</dt>
          <dd>
            {c.reasons[k.shortfall.reason]}
            {k.shortfall.refusalReason ? (
              <>
                {' '}
                (<bdi>{k.shortfall.refusalReason}</bdi>)
              </>
            ) : null}
          </dd>
          <dt>{c.delivered}</dt>
          <dd>
            <bdi>
              {k.shortfall.quantityDelivered} {k.shortfall.quantityUnit}
            </bdi>
          </dd>
          <dt>{c.remaining}</dt>
          <dd>
            <bdi>
              {k.shortfall.quantityRemaining} {k.shortfall.quantityUnit}
            </bdi>
          </dd>
          <dt>{c.onVehicle}</dt>
          <dd id="cargo-on-vehicle" data-on-vehicle={String(cargo.onVehicle)}>
            <bdi>
              {String(cargo.onVehicle)} {k.shortfall.quantityUnit}
            </bdi>
          </dd>
          <dt>{c.location}</dt>
          <dd>
            <bdi>{k.shortfall.location}</bdi>
          </dd>
          <dt>{c.condition}</dt>
          <dd>
            <bdi>{k.shortfall.cargoCondition}</bdi>
          </dd>
          <dt>{c.contactAttempts}</dt>
          <dd>{k.shortfall.contactAttempts}</dd>
          <dt>{c.responseDue}</dt>
          <dd>
            <InstantText at={k.responseDueAt} /> ({c.classes[k.cargoClass]})
          </dd>
        </dl>
      ) : null}
      {k.escalatedAt ? (
        <p className="notice" id="cargo-escalated">
          {c.escalated}
        </p>
      ) : null}
      {k.authorityOrder ? <p className="notice">{c.authorityOrder}</p> : null}
      {!open ? <p className="notice">{c.closed}</p> : null}

      {side !== 'driver' ? (
        <>
          <h4>{c.authoritiesTitle}</h4>
          {authorities.length === 0 ? (
            <p id="cargo-authorities-none">{c.authoritiesNone}</p>
          ) : (
            <ul className="evidence" id="cargo-authorities">
              {authorities.map((item) => (
                <li key={item.id} data-authority={item.holderRole} data-ended={!!item.endedAt}>
                  {item.endedAt ? (
                    <s>{c.holderRoles[item.holderRole]}</s>
                  ) : (
                    <strong>{c.holderRoles[item.holderRole]}</strong>
                  )}
                  {item.holder ? (
                    <>
                      {' '}
                      (<bdi>{item.holder}</bdi>)
                    </>
                  ) : null}
                  : {item.actions.map((code) => c.actions[code]).join(', ')}. {c.spendLimit}:{' '}
                  <bdi>
                    {item.spendLimit} {item.currency}
                  </bdi>
                  {item.validUntil ? (
                    <>
                      . {c.validUntil}: <InstantText at={item.validUntil} />
                    </>
                  ) : null}
                  {item.alternateContact ? (
                    <>
                      . {c.alternateContact}: <bdi>{item.alternateContact}</bdi>
                    </>
                  ) : null}
                  {item.endedAt ? (
                    <>
                      . {c.ended} <InstantText at={item.endedAt} />
                    </>
                  ) : null}
                  {side === 'shipper' && !item.endedAt && open ? (
                    <form action={action} className="form-inline">
                      <Hidden hidden={hidden} command="end_authority" retryKey={retryKey} />
                      <input type="hidden" name="authorityId" value={item.id} />
                      <button className="button" type="submit">
                        {c.endAuthority}
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {side === 'shipper' && open ? (
        <form action={action} className="form card" id="cargo-declare">
          <Hidden hidden={hidden} command="declare_authority" retryKey={retryKey} />
          <h4>{c.declareTitle}</h4>
          <p className="field-hint">{c.declareLead}</p>
          <Field id="cargo-holder" label={c.holder}>
            <select id="cargo-holder" name="holder" defaultValue="self">
              <option value="self">{c.holderSelf}</option>
              <option value="organiser">{c.holderOrganiser}</option>
            </select>
          </Field>
          <div className="check">
            <input
              type="checkbox"
              id="cargo-confirm-contract"
              name="confirmContract"
              value="true"
            />
            <label htmlFor="cargo-confirm-contract">{c.confirmContract}</label>
          </div>
          <fieldset className="fieldset">
            <legend>{c.actionsField}</legend>
            {CARGO_ACTIONS.map((code) => (
              <div className="check" key={code}>
                <input
                  type="checkbox"
                  id={`cargo-action-${code}`}
                  name="actions"
                  value={code}
                  defaultChecked
                />
                <label htmlFor={`cargo-action-${code}`}>{c.actions[code]}</label>
              </div>
            ))}
          </fieldset>
          <Field id="cargo-spend" label={c.spendLimit}>
            <input
              type="text"
              id="cargo-spend"
              name="spendLimit"
              inputMode="decimal"
              maxLength={16}
              required
            />
          </Field>
          <Field id="cargo-valid" label={c.validUntil}>
            <input id="cargo-valid" name="validUntil" type="datetime-local" min={now} />
          </Field>
          <Field id="cargo-contact" label={c.alternateContact}>
            <input
              type="text"
              id="cargo-contact"
              name="alternateContact"
              maxLength={300}
              required
            />
          </Field>
          <Field id="cargo-basis" label={c.basisNote}>
            <textarea id="cargo-basis" name="basisNote" maxLength={1000} required />
          </Field>
          <button className="button" type="submit" data-cargo="declare">
            {c.declare}
          </button>
        </form>
      ) : null}

      <h4>{c.instructionsTitle}</h4>
      {k.instructions.length > 0 ? (
        <ul className="evidence" id="cargo-instructions">
          {k.instructions.map((item) => (
            <InstructionItem
              key={item.id}
              c={c}
              item={item}
              side={side}
              forms={instructionForms(item)}
            />
          ))}
        </ul>
      ) : null}

      {instructing && open && !current ? (
        <form action={action} className="form card" id="cargo-issue">
          <Hidden hidden={hidden} command="issue" retryKey={retryKey} version={k.version} />
          <h4>{c.issueTitle}</h4>
          <p className="field-hint">{c.issueLead}</p>
          <Field id="cargo-action" label={c.action}>
            <select id="cargo-action" name="action" required>
              {CARGO_ACTIONS.filter(
                (code) => !k.authorityAllowedActions || k.authorityAllowedActions.includes(code),
              ).map((code) => (
                <option key={code} value={code}>
                  {c.actions[code]}
                </option>
              ))}
            </select>
          </Field>
          <Field id="cargo-destination" label={c.destination}>
            <input type="text" id="cargo-destination" name="destination" maxLength={500} />
          </Field>
          <Field id="cargo-details" label={c.details}>
            <textarea id="cargo-details" name="details" maxLength={2000} />
          </Field>
          <button className="button button-primary" type="submit" data-cargo="issue">
            {c.issue}
          </button>
        </form>
      ) : null}

      {side === 'carrier' &&
      open &&
      !k.instructions.some((item) => ['approved', 'executing'].includes(item.state)) &&
      new Date(k.responseDueAt).getTime() <= Date.now() ? (
        <form action={action} className="form card" id="cargo-emergency">
          <Hidden hidden={hidden} command="emergency" retryKey={retryKey} />
          <h4>{c.emergencyTitle}</h4>
          <p className="field-hint">{c.emergencyLead}</p>
          <Field id="cargo-emergency-action" label={c.action}>
            <select id="cargo-emergency-action" name="action">
              {(['temporary_storage', 'retry_delivery', 'return_to_sender'] as const).map(
                (code) => (
                  <option key={code} value={code}>
                    {c.actions[code]}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field id="cargo-emergency-details" label={c.details}>
            <textarea id="cargo-emergency-details" name="details" maxLength={2000} />
          </Field>
          <CostFields c={c} prefix="emergency" />
          <button className="button" type="submit" data-cargo="emergency">
            {c.emergency}
          </button>
        </form>
      ) : null}

      {k.handovers.length > 0 ? (
        <>
          <h4>{c.handoversTitle}</h4>
          <ul className="evidence" id="cargo-handovers">
            {k.handovers.map((item) => (
              <li key={item.id} data-receipt={item.receipt?.state ?? 'pending'}>
                <bdi>
                  {String(item.quantity ?? '')} {item.quantityUnit ?? ''}
                </bdi>
                : <bdi>{item.handedBy}</bdi> → <bdi>{item.receivedBy}</bdi>, <bdi>{item.place}</bdi>
                , <InstantText at={item.handedAt} />
                <br />
                <strong>
                  {item.receipt === null
                    ? c.receiptPending
                    : item.receipt.state === 'confirmed'
                      ? c.receiptConfirmed
                      : c.receiptRejected}
                </strong>
                {item.receipt ? (
                  <>
                    {' '}
                    ({c.reference}: <bdi>{item.receipt.reference}</bdi>)
                  </>
                ) : null}
                {item.receipt === null && instructing ? (
                  <form action={action} className="form-inline">
                    <Hidden hidden={hidden} command="confirm_receipt" retryKey={retryKey} />
                    <input type="hidden" name="handoverId" value={item.id} />
                    <Field id={`receipt-${item.id}`} label={c.reference}>
                      <input
                        type="text"
                        id={`receipt-${item.id}`}
                        name="reference"
                        maxLength={500}
                        required
                      />
                    </Field>
                    <button
                      className="button button-primary"
                      type="submit"
                      name="state"
                      value="confirmed"
                      data-cargo="confirm"
                    >
                      {c.confirm}
                    </button>
                    <button className="button" type="submit" name="state" value="rejected">
                      {c.reject}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {k.legs.length > 0 ? (
        <>
          <h4>{c.legsTitle}</h4>
          <ul className="evidence" id="cargo-legs">
            {k.legs.map((leg) => {
              const next =
                leg.state === 'planned'
                  ? 'departed'
                  : leg.state === 'departed'
                    ? 'arrived'
                    : leg.state === 'arrived'
                      ? 'completed'
                      : null;
              return (
                <li key={leg.id} data-leg={leg.state}>
                  {leg.destination ? <bdi>{leg.destination}</bdi> : null} {c.legStates[leg.state]}
                  {next && (side === 'carrier' || side === 'driver') ? (
                    <form action={action} className="form-inline">
                      <Hidden hidden={hidden} command="leg" retryKey={retryKey} />
                      <input type="hidden" name="legId" value={leg.id} />
                      <input type="hidden" name="step" value={next} />
                      {next === 'completed' ? (
                        <>
                          <Field id={`leg-qty-${leg.id}`} label={c.legQuantity}>
                            <input
                              type="text"
                              id={`leg-qty-${leg.id}`}
                              name="quantityDelivered"
                              inputMode="decimal"
                              maxLength={12}
                              required
                            />
                          </Field>
                          <Field id={`leg-receiver-${leg.id}`} label={c.legReceiver}>
                            <input
                              type="text"
                              id={`leg-receiver-${leg.id}`}
                              name="receiverName"
                              maxLength={200}
                            />
                          </Field>
                        </>
                      ) : null}
                      <button className="button" type="submit" data-cargo={`leg-${next}`}>
                        {next === 'departed'
                          ? c.legDepart
                          : next === 'arrived'
                            ? c.legArrive
                            : c.legComplete}
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {side !== 'driver' && (k.claims ?? []).length > 0 ? (
        <>
          <h4>{c.claimsTitle}</h4>
          <ul className="evidence" id="cargo-claims">
            {(k.claims ?? []).map((claim) => (
              <li key={claim.id} data-claim={claim.state}>
                <bdi>{claim.description}</bdi>:{' '}
                {(c.claimStates as Record<string, string>)[claim.state] ?? claim.state}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {instructing && disputable.length > 0 ? (
        <form action={action} className="form card" id="cargo-dispute">
          <Hidden hidden={hidden} command="dispute_cost" retryKey={retryKey} />
          <h4>{c.disputeTitle}</h4>
          <p className="field-hint">{c.disputeLead}</p>
          <fieldset className="fieldset">
            <legend>{c.costsTitle}</legend>
            {disputable.map((cost) => (
              <div className="check" key={cost.id}>
                <input
                  type="checkbox"
                  id={`cargo-cost-${cost.id}`}
                  name="costIds"
                  value={cost.id}
                />
                <label htmlFor={`cargo-cost-${cost.id}`}>
                  {c.kinds[cost.kind]}:{' '}
                  <bdi>
                    {cost.amount} {cost.currency}
                  </bdi>
                </label>
              </div>
            ))}
          </fieldset>
          <Field id="cargo-dispute-reason" label={c.disputeReason}>
            <textarea id="cargo-dispute-reason" name="reason" maxLength={2000} required />
          </Field>
          <div className="form-inline">
            <button
              className="button"
              type="submit"
              name="submitCommand"
              value="dispute_cost"
              data-cargo="dispute"
            >
              {c.dispute}
            </button>
            <button
              className="button"
              type="submit"
              name="submitCommand"
              value="raise_claim"
              data-cargo="claim"
            >
              {c.claim}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
