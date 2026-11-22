// Demo data for testing the whole journey by hand, on a local development database only.
//
//   npm run dev:demo:journey            prepares the people, organisations, fleet and pilot
//                                       invitations of docs/delivery/JOURNEY_TEST_SCENARIO.md
//   npm run dev:demo:journey -- --run   also runs the whole journey through the API, from
//                                       publishing a shipment to closure, and checks each step
//
// Everything is fictional. The mobile numbers use +999, which is not assigned to any country.
// The staff steps are taken by fixture staff accounts made directly in the database for the
// moment they are needed; their sessions are removed afterwards. Nothing leaves this machine:
// no message, payment or file goes anywhere.
//
// It needs the local API running (npm run dev:api) and the same .env, and refuses any database
// that is not on this machine and marked local-development.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import {
  fixtureSafeguardProblems,
  loadCountryFixtures,
} from '../../apps/api/dist/database/local.js';
import { hashToken } from '../../apps/api/dist/identity/secrets.js';

const problems = fixtureSafeguardProblems(process.env);
if (problems.length) throw new Error(problems.join(' / '));
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const origin = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const runJourney = process.argv.includes('--run');

// The people of the scenario. Each signs in with their own number; locally the one-time code is
// shown on screen.
export const PEOPLE = {
  shipper: { phone: '+999500000101', name: 'Sara Demo (fictional shipper)' },
  carrier: { phone: '+999500000102', name: 'Khalid Demo (fictional carrier)' },
  driver: { phone: '+999500000103', name: 'Omar Demo (fictional driver)' },
  invited: { phone: '+999500000104', name: 'Layla Demo (fictional, invited)' },
  uninvited: { phone: '+999500000105' },
};
const SHIPPER = { legalName: 'Demo Shipper LLC (fictional)', registrationNumber: 'JRNY-SHIP-01' };
const CARRIER = { legalName: 'Demo Carrier LLC (fictional)', registrationNumber: 'JRNY-CARR-01' };
const TRUCK_PLATE = 'JRNY101';

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------
async function api(path, { method = 'GET', token, body, retry, code = false, expect } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': retry ?? randomUUID() } : {}),
      ...(code ? { 'x-trucker-development-code': 'local-visitor' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(20000),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : {};
  const ok = expect !== undefined ? response.status === expect : response.ok;
  if (!ok)
    throw Object.assign(
      new Error(
        `${method} ${path} returned ${response.status} ${value.code ?? ''} ${JSON.stringify(value.details ?? {})}`,
      ),
      { status: response.status, code: value.code, details: value.details },
    );
  return value;
}
const post = (path, token, body, options = {}) =>
  api(path, { method: 'POST', token, body, ...options });
const step = (text) => console.log(`- ${text}`);

/** Signs in with a number; registers the person if they are not yet registered. */
async function person(who) {
  const ask = () => post('/auth/code-requests', undefined, { phone: who.phone }, { code: true });
  let challenge;
  try {
    challenge = await ask();
  } catch (error) {
    if (error.code !== 'code_resend_too_soon') throw error;
    const wait = Number(error.details?.retryAfterSeconds ?? 60);
    console.log(`  (waiting ${wait} s for a new sign-in code for ${who.phone})`);
    await sleep((wait + 1) * 1000);
    challenge = await ask();
  }
  if (!challenge.developmentCode)
    throw new Error('No local sign-in code: SIGN_IN_CODE_DELIVERY must be development-display');
  const signedIn = await post('/auth/code-verifications', undefined, {
    challengeId: challenge.challengeId,
    code: challenge.developmentCode,
  });
  if (!signedIn.person.registrationComplete) {
    const terms = await api('/registration/terms?language=en');
    await post('/me/registration', signedIn.token, {
      displayName: who.name,
      termsVersion: terms.version,
      termsLanguage: 'en',
      termsSeen: true,
    });
  }
  return { token: signedIn.token, id: signedIn.person.id, phone: who.phone };
}

/** A fixture staff account with these privileges, and a session that lasts a few minutes. */
async function staff(name, privileges) {
  const email = `journey-demo-${name}@example.test`;
  await db.query(
    `INSERT INTO trucker.staff_account
       (email, display_name, status, enrolled_at, password_hash, totp_secret, participant_link, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), 'fixture-no-password', decode('00','hex'), 'declared_none', now(), now())
     ON CONFLICT (email) DO NOTHING`,
    [email, `Journey demo ${name} (fixture)`],
  );
  const id = (await db.query('SELECT id FROM trucker.staff_account WHERE email = $1', [email]))
    .rows[0].id;
  for (const privilege of privileges)
    await db.query(
      `INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at)
       VALUES ($1, $2, NULL, now()) ON CONFLICT DO NOTHING`,
      [id, privilege],
    );
  const token = `${randomUUID()}.${randomBytes(16).toString('base64url')}`;
  await db.query(
    `INSERT INTO trucker.staff_session (id, staff_id, token_hash, created_at, last_used_at, absolute_expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '15 minutes')`,
    [id, hashToken(token)],
  );
  return { id, token, hash: hashToken(token) };
}
const sessions = [];
async function staffFor(name, privileges) {
  const made = await staff(name, privileges);
  sessions.push(made.hash);
  return made;
}

// ---------------------------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------------------------
async function invite(admin, who, organisationName) {
  const registered = await db.query(
    'SELECT 1 FROM trucker.person WHERE phone_e164 = $1 AND registration_completed_at IS NOT NULL',
    [who.phone],
  );
  if (registered.rowCount) return;
  try {
    await post('/staff/pilot-invitations', admin.token, {
      phone: who.phone,
      organisationName,
      contactName: who.name,
    });
  } catch (error) {
    if (error.code !== 'invitation_open') throw error;
  }
}

async function organisation(owner, details) {
  const found = await db.query(
    'SELECT id FROM trucker.organisation WHERE country_code = $1 AND registration_number = $2',
    ['XA', details.registrationNumber],
  );
  if (found.rows[0]) return found.rows[0].id;
  return (await post('/organisations', owner.token, { ...details, countryCode: 'XA' })).organisation
    .id;
}

async function verify(owner, org, capability, reviewer) {
  const root = `/organisations/${org}/verification`;
  const { verification } = await api(root, { token: owner.token });
  if (verification.capabilities.some((item) => item.capability === capability && item.effective))
    return;
  let application = verification.applications.find(
    (item) => item.capability === capability && item.status === 'submitted',
  );
  if (!application) {
    const licence = capability === 'ship' ? 'transport_licence' : 'haulage_licence';
    const submitted = await post(root + '/applications', owner.token, {
      declarationAccepted: true,
      declarationLanguage: 'en',
      version: verification.organisation.version,
      capability,
      ...(capability === 'carry_as_company'
        ? { service: { countries: ['XA', 'XB'], equipmentTypes: ['curtain_side'] } }
        : {}),
      evidence: ['registration_certificate', licence].map((type, index) => ({
        documentType: type,
        documentNumber: `JRNY-DOC-${index + 1}`,
        issuingCountry: 'XA',
      })),
    });
    application = submitted.verification.applications.find(
      (item) => item.capability === capability,
    );
  }
  const version = (
    await db.query('SELECT row_version FROM trucker.verification_application WHERE id = $1', [
      application.id,
    ])
  ).rows[0].row_version;
  await post(`/staff/verification/${application.id}/decision`, reviewer.token, {
    version,
    decision: 'verified',
    reason: 'evidence_accepted',
    noConflict: true,
  });
}

const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const document = (type, extra = {}) => ({
  type,
  documentNumber: `JRNY-${type.toUpperCase().slice(10, 22)}`,
  issuingCountry: 'XA',
  expiryDate: inDays(200),
  ...extra,
});

async function acceptDocuments(reviewer, subject) {
  const { fleet } = await api('/staff/fleet', { token: reviewer.token });
  for (const item of fleet.documents.filter(
    (doc) => doc.vehicleId === subject || doc.personId === subject,
  ))
    await post(`/staff/fleet/documents/${item.id}/decision`, reviewer.token, {
      version: item.version,
      decision: 'accepted',
      reason: 'document_accepted',
      noConflict: true,
    });
}

async function fleet(carrier, org, driver, reviewer) {
  const root = `/organisations/${org}/fleet`;
  let { fleet: current } = await api(root, { token: carrier.token });
  let truck = current.vehicles.find((vehicle) => vehicle.registrationNumber === TRUCK_PLATE);
  if (!truck) {
    truck = (
      await post(root + '/vehicles', carrier.token, {
        kind: 'truck',
        category: 'fictional_rigid_truck',
        equipmentType: 'curtain_side',
        registrationCountry: 'XA',
        registrationNumber: TRUCK_PLATE,
      })
    ).vehicle;
  }
  if (truck.ownership !== 'verified')
    await post(`/staff/fleet/vehicles/${truck.id}/ownership`, reviewer.token, {
      version: truck.version,
      decision: 'verified',
      reason: 'ownership_evidence_accepted',
      noConflict: true,
    });
  for (const type of ['fictional_registration_card', 'fictional_insurance_certificate'])
    if (!truck.documents.some((item) => item.type === type))
      await post(`${root}/vehicles/${truck.id}/documents`, carrier.token, document(type));
  await acceptDocuments(reviewer, truck.id);

  // The driver: invited by the carrier, accepts, sends their documents, and is authorised.
  let side = (await api('/me/driver', { token: driver.token })).driver;
  if (!side.affiliation) {
    let invitation = side.invitations.find((item) => item.carrier.legalName === CARRIER.legalName);
    if (!invitation) {
      await post(root + '/drivers', carrier.token, { phone: driver.phone });
      side = (await api('/me/driver', { token: driver.token })).driver;
      invitation = side.invitations.find((item) => item.carrier.legalName === CARRIER.legalName);
    }
    await post(`/me/driver/invitations/${invitation.id}/respond`, driver.token, {
      version: invitation.version,
      decision: 'accept',
    });
    side = (await api('/me/driver', { token: driver.token })).driver;
  }
  for (const type of ['fictional_driving_licence', 'fictional_identity_card'])
    if (!side.documents.some((item) => item.type === type))
      await post(
        '/me/driver/documents',
        driver.token,
        document(
          type,
          type === 'fictional_driving_licence' ? { licenceClasses: ['fictional_class_2'] } : {},
        ),
      );
  await acceptDocuments(reviewer, driver.id);
  current = (await api(root, { token: carrier.token })).fleet;
  const affiliation = current.drivers.find((item) => item.id === side.affiliation.id);
  if (!(affiliation.authorisations ?? []).some((item) => item.vehicleId === null))
    await post(`${root}/drivers/${affiliation.id}/authorisations`, carrier.token, {
      vehicleId: null,
      granted: true,
    });
  return { truckId: truck.id, affiliationId: affiliation.id };
}

async function prepare() {
  const kind = (await db.query('SELECT kind FROM trucker.environment')).rows[0]?.kind;
  if (kind !== 'local-development')
    throw new Error(
      'The journey demo needs a database marked local-development (npm run dev:fixtures)',
    );
  await loadCountryFixtures(db);
  const admin = await staffFor('admin-a', ['staff_admin', 'reviewer', 'operations']);
  step(
    'Pilot invitations recorded for the shipper, the carrier and Layla (the driver is invited by the carrier)',
  );
  await invite(admin, PEOPLE.shipper, SHIPPER.legalName);
  await invite(admin, PEOPLE.carrier, CARRIER.legalName);
  await invite(admin, PEOPLE.invited, 'Demo Second Shipper (fictional)');
  const shipper = await person(PEOPLE.shipper);
  const carrier = await person(PEOPLE.carrier);
  step(`Registered: ${PEOPLE.shipper.name} and ${PEOPLE.carrier.name}`);
  const shipperOrg = await organisation(shipper, SHIPPER);
  const carrierOrg = await organisation(carrier, CARRIER);
  await verify(shipper, shipperOrg, 'ship', admin);
  await verify(carrier, carrierOrg, 'carry_as_company', admin);
  step(
    `Verified: ${SHIPPER.legalName} (shipper) and ${CARRIER.legalName} (carrier, XA and XB, curtain-side)`,
  );
  // The driver is invited by the carrier before registering, so needs no pilot invitation.
  const carrierFleet = `/organisations/${carrierOrg}/fleet`;
  const { fleet: before } = await api(carrierFleet, { token: carrier.token });
  if (!before.drivers.some((item) => item.phone === PEOPLE.driver.phone))
    await post(carrierFleet + '/drivers', carrier.token, { phone: PEOPLE.driver.phone });
  const driver = await person(PEOPLE.driver);
  const resources = await fleet(carrier, carrierOrg, driver, admin);
  step(
    `Fleet ready: truck ${TRUCK_PLATE} (curtain-side) and driver ${PEOPLE.driver.name}, documents accepted`,
  );
  return { shipper, carrier, driver, shipperOrg, carrierOrg, ...resources };
}

// ---------------------------------------------------------------------------------------------
// The whole journey, through the API (--run)
// ---------------------------------------------------------------------------------------------
// Local times in country XA (UTC+4) and XB (UTC+3), as the forms take them.
const local = (hours, zone) =>
  new Date(Date.now() + (hours + zone) * 3600000).toISOString().slice(0, 16);
function fictionalFile(kind, mediaType = 'image/jpeg') {
  const bytes = randomBytes(4096);
  if (mediaType === 'image/jpeg') bytes.set([0xff, 0xd8, 0xff], 0);
  return {
    bytes,
    declared: {
      kind,
      mediaType,
      sizeBytes: bytes.length,
      fingerprint: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

async function journey(ready) {
  const { shipper, carrier, driver, shipperOrg, carrierOrg, truckId, affiliationId } = ready;
  const ref = `JRNY-${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}`;
  const shipments = `/organisations/${shipperOrg}/shipments`;
  // 1. The shipper drafts and publishes. Pick-up opens in 8 hours, so dispatch is allowed now.
  const made = (
    await post(shipments, shipper.token, {
      shipperReference: ref,
      cargoDescription: 'Packed ceramic tiles, 24 pallets (fictional)',
      grossWeightKg: '12000',
      pieces: '24',
      pickup: {
        address: 'Warehouse 7, Demo Industrial Area (fictional)',
        countryCode: 'XA',
        timeZone: 'Etc/GMT-4',
        accessNotes: 'Gate 2, ask for the duty supervisor (fictional)',
        from: { local: local(8, 4) },
        until: { local: local(10, 4) },
      },
      delivery: {
        address: 'Store 3, Demo Port District (fictional)',
        countryCode: 'XB',
        timeZone: 'Etc/GMT-3',
        accessNotes: 'Receiving bay B (fictional)',
        from: { local: local(14, 3) },
        until: { local: local(18, 3) },
      },
    })
  ).shipment;
  const published = (
    await post(`${shipments}/${made.id}/publish`, shipper.token, {
      version: made.version,
      cargoCategory: 'general_dry',
      equipmentType: 'curtain_side',
      dangerousGoods: false,
      pickupArea: 'Demo Industrial Area',
      deliveryArea: 'Demo Port District',
      quotationDeadline: { local: local(4, 4) },
    })
  ).shipment;
  await post(`${shipments}/${published.id}/quotation-terms`, shipper.token, {
    version: 0,
    currency: 'XTS',
  });
  step(`Shipment ${ref} published, quotations open in XTS (fictional currency)`);

  // 2. The carrier finds it and quotes.
  const quotation = (
    await post(
      `/organisations/${carrierOrg}/discovery/shipments/${published.id}/quotations`,
      carrier.token,
      {
        amount: '1250.50',
        inclusions: { fictional_item_1: true, fictional_item_2: false, fictional_item_3: false },
        validUntil: { local: local(3, 4) },
        earliestPickup: { local: local(8.5, 4) },
        notes: 'Curtain-side truck available (fictional)',
      },
    )
  ).quotation;
  step('The carrier quoted 1250.50 XTS');

  // 3. The shipper accepts: a booking, awaiting Trucker's fee and resources.
  const booking = (
    await post(`/organisations/${shipperOrg}/quotations/${quotation.id}/accept`, shipper.token, {
      version: quotation.currentVersion,
    })
  ).booking;
  step(
    `Booking made (${booking.status}): freight ${booking.transportAmount}, Trucker's fee ${booking.fee.amount} ${booking.currency}`,
  );

  // 4. Two administrators record and approve the fee received by bank transfer.
  const feeA = await staffFor('admin-a', ['staff_admin', 'reviewer', 'operations']);
  const feeB = await staffFor('admin-b', ['staff_admin', 'reviewer']);
  const { fees } = await api('/staff/fee-payments', { token: feeA.token });
  const due = fees.due.find((item) => item.bookingId === booking.id);
  const payment = (
    await post('/staff/fee-payments', feeA.token, {
      reference: due.reference,
      amount: due.amount,
      currency: due.currency,
      valueDate: new Date().toISOString().slice(0, 10),
      statementReference: `STMT-${randomBytes(4).toString('hex').toUpperCase()}`,
    })
  ).payment;
  const same = await post(
    `/staff/fee-payments/${payment.id}/decision`,
    feeA.token,
    { version: payment.version, decision: 'approve' },
    { expect: 409 },
  );
  if (same.code !== 'different_person_required')
    throw new Error('the same administrator approved the fee');
  await post(`/staff/fee-payments/${payment.id}/decision`, feeB.token, {
    version: payment.version,
    decision: 'approve',
  });
  step('Fee recorded by one administrator and approved by another (the same one was refused)');

  // 5. The carrier assigns the truck and driver; the driver acknowledges.
  const bookingPath = `/organisations/${carrierOrg}/bookings/${booking.id}`;
  let detail = (await api(bookingPath, { token: carrier.token })).booking;
  const assigned = await post(`${bookingPath}/assignment`, carrier.token, {
    version: detail.assignmentVersion,
    truckId,
    trailerId: null,
    driverId: affiliationId,
  });
  if (assigned.outcome !== 'confirmed') throw new Error(`assignment outcome ${assigned.outcome}`);
  const assignment = (
    await api('/me/driver/assignments', { token: driver.token })
  ).assignments.find((item) => item.bookingId === booking.id);
  await post(`/me/driver/assignments/${booking.id}/acknowledge`, driver.token, {
    version: assignment.version,
  });
  step('Truck and driver assigned, booking confirmed, the driver acknowledged');

  // 6. Dispatch, then the driver's milestones.
  await post(`${bookingPath}/dispatch`, carrier.token, undefined);
  const milestones = [
    'departed_for_pickup',
    'arrived_at_pickup',
    'loading_started',
    'loaded_departed',
    'arrived_at_delivery',
  ];
  for (const [index, milestone] of milestones.entries()) {
    await sleep(1100);
    await post(`/me/driver/assignments/${booking.id}/milestones`, driver.token, {
      version: index + 1,
      milestone,
    });
  }
  step('Dispatched; the driver recorded every milestone up to arrival at delivery');

  // 7. Delivery in full, the proof of delivery, and the shipper's acceptance.
  await post(`/me/driver/assignments/${booking.id}/delivery`, driver.token, {
    version: 0,
    outcome: 'delivered_in_full',
    receiverName: 'Receiver Demo (fictional)',
    remarks: null,
  });
  const files = [fictionalFile('signature'), fictionalFile('cargo_photo')];
  const declared = await post(`/me/driver/assignments/${booking.id}/pod`, driver.token, {
    version: 1,
    items: files.map((file) => file.declared),
  });
  const items = declared.pod.versions.at(-1).items;
  for (const [index, item] of items.entries()) {
    const sent = await fetch(`${origin}/me/driver/assignments/${booking.id}/pod/items/${item.id}`, {
      method: 'PUT',
      headers: {
        'content-type': files[index].declared.mediaType,
        authorization: `Bearer ${driver.token}`,
      },
      body: files[index].bytes,
    });
    if (!sent.ok) throw new Error(`POD file refused: ${sent.status} ${await sent.text()}`);
  }
  const shipperBooking = `/organisations/${shipperOrg}/bookings/${booking.id}`;
  const pod = (await api(shipperBooking, { token: shipper.token })).booking.trip.pod.versions.at(
    -1,
  );
  await post(`${shipperBooking}/pod/review`, shipper.token, {
    podId: pod.id,
    version: pod.version,
    decision: 'accepted',
    note: null,
  });
  for (const role of ['truck', 'driver'])
    await post(`${bookingPath}/resources/${role}/release`, carrier.token, undefined);
  step(
    'Delivered in full; signature and photo sent; the shipper accepted the POD; truck and driver released',
  );

  // 8. Freight paid outside Trucker: reported by the shipper, confirmed by the carrier, then
  //    reviewed and reconciled by two different administrators. Trucker's fee is reconciled too.
  //    A statement line is matched to one payment only, so every reference names this run.
  const financial = await api(`${shipperBooking}/financial-completion`, { token: shipper.token });
  const freight = financial.obligations.find((item) => item.kind === 'freight');
  const reported = await post(`${shipperBooking}/financial-completion`, shipper.token, {
    action: 'report',
    kind: 'freight',
    amount: freight.amount,
    currency: freight.currency,
    reference: `Bank transfer ${ref} (fictional)`,
    evidence: 'Transfer receipt held by the shipper (fictional)',
  });
  await post(`${bookingPath}/financial-completion`, carrier.token, {
    action: 'confirm',
    paymentId: reported.paymentId,
  });
  const staffPath = `/staff/operations/bookings/${booking.id}/financial-completion`;
  await post(staffPath, feeA.token, {
    action: 'review',
    paymentId: reported.paymentId,
    note: 'Compared the transfer receipt (fictional)',
  });
  await post(staffPath, feeB.token, {
    action: 'reconcile',
    paymentId: reported.paymentId,
    amount: freight.amount,
    currency: freight.currency,
    reference: `Statement line ${ref} (fictional)`,
    evidence: 'Bank statement page 1 (fictional)',
  });
  const fee = (
    await db.query(
      "SELECT id, amount::text, currency_code FROM trucker.fee_payment WHERE booking_id = $1 AND status = 'approved'",
      [booking.id],
    )
  ).rows[0];
  // A third administrator, who had no hand in recording or approving the fee, reconciles it.
  const feeC = await staffFor('admin-c', ['staff_admin']);
  await post('/staff/reconciliations', feeC.token, {
    subjectType: 'payment',
    subjectId: fee.id,
    source: 'bank_statement',
    sourceReference: `Trucker fee statement line ${ref} (fictional)`,
    amount: fee.amount,
    currency: fee.currency_code,
  });
  step(
    'Freight reported and confirmed by the parties; reviewed and reconciled by two administrators; the fee reconciled by a third',
  );

  // 9. Closure: the trip watcher of the API checks every minute.
  for (let wait = 0; wait < 150; wait += 5) {
    const closure = await api(`${shipperBooking}/closure`, { token: shipper.token });
    if (closure.state === 'closed') {
      step('Closed by the API on its own, once every condition held');
      return { booking: booking.id, reference: ref };
    }
    await sleep(5000);
  }
  throw new Error('the booking did not close within 150 seconds');
}

try {
  const ready = await prepare();
  if (runJourney) {
    console.log('Running the whole journey through the API:');
    const done = await journey(ready);
    console.log(`Journey complete: booking ${done.booking} (${done.reference}) is closed.`);
  }
  console.log(`
Ready. Sign in on the web application (http://localhost:3100) with:
  Shipper  ${PEOPLE.shipper.phone}  ${SHIPPER.legalName}
  Carrier  ${PEOPLE.carrier.phone}  ${CARRIER.legalName}
  Driver   ${PEOPLE.driver.phone}  driver of ${CARRIER.legalName}
  Invited  ${PEOPLE.invited.phone}  invited, not yet registered
  Not invited  ${PEOPLE.uninvited.phone}
The one-time code is shown on screen. Follow docs/delivery/JOURNEY_TEST_SCENARIO.md.`);
} finally {
  if (sessions.length)
    await db.query('DELETE FROM trucker.staff_session WHERE token_hash = ANY($1::text[])', [
      sessions,
    ]);
  await db.end();
}
