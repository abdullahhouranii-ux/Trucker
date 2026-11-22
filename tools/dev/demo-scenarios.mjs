import { randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import {
  fixtureSafeguardProblems,
  loadCountryFixtures,
} from '../../apps/api/dist/database/local.js';
import { matching } from '../../apps/api/dist/testing/fee.js';
import { hashToken } from '../../apps/api/dist/identity/secrets.js';
import { ensureQuotationFleet } from '../../apps/api/dist/testing/quotation-fleet.js';

const errors = fixtureSafeguardProblems(process.env);
if (errors.length) throw new Error(errors.join(' / '));
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const origin = 'http://127.0.0.1:3000';
const key = () => randomUUID();
const phone = '+999574021836';
async function api(path, { method = 'GET', token, body, code = false, expect, retry } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(body || retry ? { 'idempotency-key': retry ?? key() } : {}),
      ...(code ? { 'x-trucker-development-code': 'local-visitor' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(15000),
  });
  const value = await response.json();
  if (response.status === 429 && value.code === 'code_resend_too_soon') {
    throw Object.assign(new Error('Wait for the local sign-in challenge'), {
      code: value.code,
      wait: value.details?.retryAfterSeconds,
    });
  }
  if (expect !== undefined ? response.status !== expect : !response.ok)
    throw new Error(
      method +
        ' ' +
        path +
        ' returned ' +
        response.status +
        ' ' +
        (value.code ?? '') +
        ' ' +
        JSON.stringify(value.details?.problems ?? []),
    );
  return value;
}
const post = (path, token, body, expect) => api(path, { token, body, method: 'POST', expect });

async function identity() {
  const issue = () =>
    api('/auth/code-requests', {
      method: 'POST',
      body: { phone },
      code: true,
    });
  let challenge;
  try {
    challenge = await issue();
  } catch (error) {
    if (error.code !== 'code_resend_too_soon' || !Number.isInteger(error.wait) || error.wait > 120)
      throw error;
    await sleep((error.wait + 1) * 1000);
    challenge = await issue();
  }
  if (!challenge.developmentCode) throw new Error('Local one-time code was not available');
  const account = await post('/auth/code-verifications', undefined, {
    challengeId: challenge.challengeId,
    code: challenge.developmentCode,
  });
  const own = await db.query('SELECT id FROM trucker.person WHERE phone_e164=$1', [phone]);
  if (!own.rows[0])
    throw new Error('The local API and fixture database do not share the demo account');
  if (!account.person.registrationComplete) {
    const terms = await api('/registration/terms?language=en');
    await post('/me/registration', account.token, {
      displayName: 'Trucker Demo (fictional)',
      termsVersion: terms.version,
      termsLanguage: 'en',
      termsSeen: true,
    });
  }
  return { id: own.rows[0].id, token: account.token };
}

async function organisation(person, registrationNumber, legalName) {
  const found = await db.query(
    'SELECT id FROM trucker.organisation WHERE country_code=$1 AND registration_number=$2',
    ['XA', registrationNumber],
  );
  if (found.rows[0]) {
    await api('/organisations/' + found.rows[0].id, { token: person.token });
    return found.rows[0].id;
  }
  return (
    await post('/organisations', person.token, { legalName, countryCode: 'XA', registrationNumber })
  ).organisation.id;
}

async function fixtureStaff(user = 'reviewer', privilege = 'reviewer') {
  const email = 'trucker-demo-fixture-' + user + '@example.test';
  const created = await db.query(
    `INSERT INTO trucker.staff_account
       (email, display_name, status, enrolled_at, password_hash, totp_secret, participant_link, created_at, updated_at)
     VALUES ($1, 'Demo Fixture Reviewer', 'active', now(), 'fixture-no-password', decode('00','hex'), 'declared_none', now(), now())
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email],
  );
  const staffId =
    created.rows[0]?.id ??
    (await db.query('SELECT id FROM trucker.staff_account WHERE email=$1', [email])).rows[0].id;
  await db.query(
    `INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at)
     VALUES ($1, $2, NULL, now()) ON CONFLICT DO NOTHING`,
    [staffId, privilege],
  );
  const token = key() + '.' + randomBytes(16).toString('base64url');
  const hash = hashToken(token);
  await db.query(
    `INSERT INTO trucker.staff_session (id, staff_id, token_hash, created_at, last_used_at, absolute_expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '15 minutes')`,
    [staffId, hash],
  );
  return { token, hash };
}

async function verify(person, org, capability, staffToken) {
  const root = '/organisations/' + org + '/verification';
  const { verification } = await api(root, { token: person.token });
  if (verification.capabilities.some((item) => item.capability === capability && item.effective))
    return;
  let application = verification.applications.find(
    (item) => item.capability === capability && item.status === 'submitted',
  );
  if (!application) {
    const documentType = capability === 'ship' ? 'transport_licence' : 'haulage_licence';
    const submitted = await post(root + '/applications', person.token, {
      declarationAccepted: true,
      declarationLanguage: 'en',
      version: verification.organisation.version,
      capability,
      ...(capability === 'carry_as_company'
        ? { service: { countries: ['XA', 'XB'], equipmentTypes: ['curtain_side'] } }
        : {}),
      evidence: ['registration_certificate', documentType].map((type, index) => ({
        documentType: type,
        documentNumber: 'DEMO-' + (index + 1),
        issuingCountry: 'XA',
      })),
    });
    application = submitted.verification.applications[0];
  }
  const version = (
    await db.query('SELECT row_version FROM trucker.verification_application WHERE id=$1', [
      application.id,
    ])
  ).rows[0].row_version;
  await post('/staff/verification/' + application.id + '/decision', staffToken, {
    version,
    decision: 'verified',
    reason: 'evidence_accepted',
    noConflict: true,
  });
}

async function readyResources(person, carrier, truckId, staffToken) {
  const fleetRoot = '/organisations/' + carrier + '/fleet';
  const driver = () => api('/me/driver', { token: person.token }).then(({ driver }) => driver);
  let side = await driver();
  if (!side.affiliation) {
    let invitation = side.invitations.find(
      (item) => item.carrier.legalName === 'Trucker Demo Matching Fleet (fictional)',
    );
    if (!invitation) {
      await post(fleetRoot + '/drivers', person.token, { phone });
      invitation = (await driver()).invitations.find(
        (item) => item.carrier.legalName === 'Trucker Demo Matching Fleet (fictional)',
      );
    }
    if (!invitation) throw new Error('Demo driver invitation not available');
    await post('/me/driver/invitations/' + invitation.id + '/respond', person.token, {
      version: invitation.version,
      decision: 'accept',
    });
    side = await driver();
  }
  const fleet = (await api(fleetRoot, { token: person.token })).fleet;
  const truck = fleet.vehicles.find(({ id }) => id === truckId);
  const affiliation = fleet.drivers.find(({ id }) => id === side.affiliation?.id);
  if (!truck || !affiliation)
    throw new Error('Fixture resources are not linked to the demo carrier');
  const expiryDate = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
  const document = (type, extra = {}) => ({
    type,
    documentNumber: 'DEMO-' + type,
    issuingCountry: 'XA',
    expiryDate,
    ...extra,
  });
  for (const type of ['fictional_registration_card', 'fictional_insurance_certificate']) {
    if (!truck.documents.some((item) => item.type === type))
      await post(fleetRoot + '/vehicles/' + truckId + '/documents', person.token, document(type));
  }
  for (const type of ['fictional_driving_licence', 'fictional_identity_card']) {
    if (!side.documents.some((item) => item.type === type))
      await post(
        '/me/driver/documents',
        person.token,
        document(
          type,
          type === 'fictional_driving_licence' ? { licenceClasses: ['fictional_class_2'] } : {},
        ),
      );
  }
  const queue = (await api('/staff/fleet', { token: staffToken })).fleet;
  for (const item of queue.documents.filter(
    (doc) => doc.vehicleId === truckId || doc.personId === person.id,
  )) {
    await post('/staff/fleet/documents/' + item.id + '/decision', staffToken, {
      version: item.version,
      decision: 'accepted',
      reason: 'document_accepted',
      noConflict: true,
    });
  }
  await post(fleetRoot + '/drivers/' + affiliation.id + '/authorisations', person.token, {
    vehicleId: truckId,
    granted: true,
  });
  return affiliation.id;
}

const instant = Date.now();
const local = (hours, zone = 4) =>
  new Date(instant + (hours + zone) * 3600000).toISOString().slice(0, 16);
const area = (label, country, zone, start, end) => ({
  address: label + ' (fictional)',
  countryCode: country,
  timeZone: 'Etc/GMT-' + zone,
  from: { local: local(start, zone) },
  until: { local: local(end, zone) },
});

async function seed() {
  const kind = (await db.query('SELECT kind FROM trucker.environment')).rows[0]?.kind;
  if (kind !== 'local-development')
    throw new Error('Demo scenarios require a database already marked local-development');
  await loadCountryFixtures(db);
  const person = await identity();
  const shipper = await organisation(person, 'TRKDEMO01', 'Trucker Demo Shipper (fictional)');
  const carrier = await organisation(
    person,
    'TRKDEMO02',
    'Trucker Demo Matching Fleet (fictional)',
  );
  const unmatched = await organisation(
    person,
    'TRKDEMO03',
    'Trucker Demo No Matching Fleet (fictional)',
  );
  const reviewerSession = await fixtureStaff();
  try {
    await verify(person, shipper, 'ship', reviewerSession.token);
    await verify(person, carrier, 'carry_as_company', reviewerSession.token);
    await verify(person, unmatched, 'carry_as_company', reviewerSession.token);
  } finally {
    await db.query('DELETE FROM trucker.staff_session WHERE token_hash=$1', [reviewerSession.hash]);
  }
  const root = '/organisations/' + shipper + '/shipments';
  const lookup = async (reference) => {
    const result = await db.query(
      'SELECT id FROM trucker.shipment_draft WHERE organisation_id=$1 AND shipper_reference=$2 ORDER BY created_at DESC LIMIT 1',
      [shipper, reference],
    );
    if (!result.rows[0]) return null;
    return (await api(root + '/' + result.rows[0].id, { token: person.token })).shipment;
  };
  async function scenario(reference, name, live, delay = 0) {
    let shipment = await lookup(reference);
    if (!shipment) {
      shipment = (
        await post(root, person.token, {
          shipperReference: reference,
          cargoDescription: name,
          grossWeightKg: '12000',
          pieces: '24',
          pickup: area('Demo pickup', 'XA', 4, 240 + delay, 244 + delay),
          delivery: area('Demo delivery', 'XB', 3, 248 + delay, 254 + delay),
        })
      ).shipment;
    }
    if (live && shipment.status === 'draft') {
      shipment = (
        await post(root + '/' + shipment.id + '/publish', person.token, {
          version: shipment.version,
          cargoCategory: 'general_dry',
          equipmentType: 'curtain_side',
          dangerousGoods: false,
          pickupArea: 'Demo industrial area',
          deliveryArea: 'Demo port district',
          quotationDeadline: { local: local(192 + delay) },
        })
      ).shipment;
    }
    return shipment;
  }
  const draft = await scenario('TRK-DEMO-DRAFT', 'مسودة تجريبية — بلاط معبأ', false);
  const originalOpen = await scenario('TRK-DEMO-OPEN', 'شحنة تجريبية منشورة — بضائع عامة', true);
  const open =
    originalOpen.status === 'awarded'
      ? await scenario('TRK-DEMO-OPEN-NEXT', 'شحنة تجريبية منشورة — بضائع عامة', true)
      : originalOpen;
  let withdrawn = await scenario('TRK-DEMO-WITHDRAWN', 'شحنة تجريبية مسحوبة', true);
  if (['published', 'suspended'].includes(withdrawn.status)) {
    withdrawn = (
      await post(root + '/' + withdrawn.id + '/withdraw', person.token, {
        version: withdrawn.version,
      })
    ).shipment;
  }
  const bookingCase = await scenario('TRK-DEMO-BOOKING', 'شحنة تجريبية — عروض وحجز', true);
  await ensureQuotationFleet(db, person.id, carrier, open.id);
  if (open.status === 'published') {
    const openPath = root + '/' + open.id;
    const { quotations } = await api(openPath + '/quotations', { token: person.token });
    if (!quotations.terms)
      await post(openPath + '/quotation-terms', person.token, { version: 0, currency: 'XTS' });
  }
  const offered =
    '/organisations/' + carrier + '/discovery/shipments/' + bookingCase.id + '/quotations';
  const denied =
    '/organisations/' + unmatched + '/discovery/shipments/' + bookingCase.id + '/quotations';
  const quoteBody = {
    amount: '1250.50',
    inclusions: { fictional_item_1: true, fictional_item_2: false, fictional_item_3: false },
    validUntil: { local: local(165) },
    earliestPickup: { local: local(241) },
  };
  if (bookingCase.status === 'published') {
    const bookingRoot = root + '/' + bookingCase.id;
    let list = (await api(bookingRoot + '/quotations', { token: person.token })).quotations;
    if (!list.terms)
      await post(bookingRoot + '/quotation-terms', person.token, { version: 0, currency: 'XTS' });
    list = (await api(bookingRoot + '/quotations', { token: person.token })).quotations;
    const refused = await post(denied, person.token, quoteBody, 409);
    if (refused.code !== 'fleet_mismatch')
      throw new Error('Unexpected unmatched quotation refusal: ' + refused.code);
    const quotation =
      list.quotations.find((q) => q.carrier?.id === carrier && q.status === 'submitted') ??
      (await post(offered, person.token, quoteBody)).quotation;
    await post(
      '/organisations/' + shipper + '/quotations/' + quotation.id + '/accept',
      person.token,
      { version: quotation.currentVersion },
    );
  }
  async function assignScenario(reference, label, delay = 0) {
    const assignedShipment = await scenario(reference, label, true, delay);
    const assignedRoot = root + '/' + assignedShipment.id;
    if (assignedShipment.status === 'published') {
      let { quotations } = await api(assignedRoot + '/quotations', { token: person.token });
      if (!quotations.terms) {
        await post(assignedRoot + '/quotation-terms', person.token, {
          version: 0,
          currency: 'XTS',
        });
        ({ quotations } = await api(assignedRoot + '/quotations', { token: person.token }));
      }
      const quote =
        quotations.quotations.find(
          (item) => item.carrier?.id === carrier && item.status === 'submitted',
        ) ??
        (
          await post(
            '/organisations/' +
              carrier +
              '/discovery/shipments/' +
              assignedShipment.id +
              '/quotations',
            person.token,
            {
              ...quoteBody,
              validUntil: { local: local(165 + delay) },
              earliestPickup: { local: local(241 + delay) },
            },
          )
        ).quotation;
      await post(
        '/organisations/' + shipper + '/quotations/' + quote.id + '/accept',
        person.token,
        {
          version: quote.currentVersion,
        },
      );
    }
    const assignedBooking = (await api(assignedRoot + '/booking', { token: person.token })).booking;
    if (!assignedBooking?.id) throw new Error('Assigned fixture booking not available');
    const carrierBooking = '/organisations/' + carrier + '/bookings/' + assignedBooking.id;
    let details = await api(carrierBooking, { token: person.token });
    if (!details.booking.resources?.driver) {
      const {
        rows: [truck],
      } = await db.query(
        "SELECT id FROM trucker.vehicle WHERE organisation_id=$1 AND equipment_type='curtain_side' AND ownership='verified' ORDER BY created_at LIMIT 1",
        [carrier],
      );
      if (!truck) throw new Error('Demo truck not available');
      const fleetReviewer = await fixtureStaff();
      try {
        const driverId = await readyResources(person, carrier, truck.id, fleetReviewer.token);
        await post(carrierBooking + '/assignment', person.token, {
          version: details.booking.assignmentVersion,
          truckId: truck.id,
          trailerId: null,
          driverId,
        });
      } finally {
        await db.query('DELETE FROM trucker.staff_session WHERE token_hash=$1', [
          fleetReviewer.hash,
        ]);
      }
      details = await api(carrierBooking, { token: person.token });
    }
    const driverPath = '/me/driver/assignments';
    const getAssignment = async () =>
      (await api(driverPath, { token: person.token })).assignments.find(
        (item) => item.bookingId === assignedBooking.id,
      );
    const assignment = await getAssignment();
    if (!assignment || !details.booking.resources?.truck || !details.booking.resources?.driver)
      throw new Error('Assigned demo trip is not visible');
    if (!assignment.acknowledgedAt) {
      await post(driverPath + '/' + assignedBooking.id + '/acknowledge', person.token, {
        version: assignment.version,
      });
    }
    if (!(await getAssignment())?.acknowledgedAt)
      throw new Error('Driver acknowledgement not recorded');
    return { details, carrierBooking };
  }
  const assigned = await assignScenario('TRK-DEMO-ASSIGNED', 'شحنة تجريبية — مركبة وسائق');
  const paid = await assignScenario('TRK-DEMO-PAID', 'شحنة تجريبية — رسوم مؤكدة', 72);
  if (paid.details.booking.status === 'awaiting_fee') {
    const recorder = await fixtureStaff('fee-recorder', 'staff_admin');
    let approver;
    try {
      approver = await fixtureStaff('fee-approver', 'staff_admin');
      const { fees } = await api('/staff/fee-payments', { token: recorder.token });
      const bookingId = paid.details.booking.id;
      const due = fees.due.find((item) => item.bookingId === bookingId);
      if (!due) throw new Error('Demo booking fee is not due');
      const pending = fees.awaitingApproval.find((item) => item.bookingId === bookingId);
      const payment =
        pending ?? (await post('/staff/fee-payments', recorder.token, matching(due))).payment;
      const approvalPath = '/staff/fee-payments/' + payment.id + '/decision';
      const decision = { version: payment.version, decision: 'approve' };
      const same = await post(approvalPath, recorder.token, decision, 409);
      if (same.code !== 'different_person_required')
        throw new Error('Fee maker-checker check failed');
      await post(approvalPath, approver.token, decision);
    } finally {
      await db.query('DELETE FROM trucker.staff_session WHERE token_hash = ANY($1::text[])', [
        [recorder.hash, ...(approver ? [approver.hash] : [])],
      ]);
    }
  }
  const ready = (await api(paid.carrierBooking, { token: person.token })).booking;
  if (
    ready.status !== 'confirmed' ||
    ready.feePayment?.status !== 'paid' ||
    ready.dispatch?.ready !== true
  )
    throw new Error('Demo booking has not reached dispatch readiness');
  const dispatchFrom = Date.parse(ready.dispatchFrom);
  if (!Number.isFinite(dispatchFrom)) throw new Error('Demo dispatch window is unavailable');
  const early = Date.now() < dispatchFrom;
  if (early) {
    const refused = await api(paid.carrierBooking + '/dispatch', {
      method: 'POST',
      token: person.token,
      retry: key(),
      expect: 409,
    });
    if (refused.code !== 'dispatch_refused' || refused.details?.reason !== 'too_early')
      throw new Error(
        'Early dispatch was not refused for the expected reason: ' +
          JSON.stringify(refused.details ?? {}),
      );
  }
  const booked = await lookup('TRK-DEMO-BOOKING');
  const { booking } = await api(root + '/' + booked.id + '/booking', { token: person.token });
  if (!booking?.id || booked.status !== 'awarded') throw new Error('Fixture booking not available');
  const board = await api('/public/shipments');
  if (
    !board.items.some(({ id }) => id === open.id) ||
    board.items.some(({ id }) => id === withdrawn.id)
  )
    throw new Error('Public board does not reflect fixture publication states');
  console.log(
    JSON.stringify({
      draft: draft.status,
      open: open.status,
      withdrawn: withdrawn.status,
      booking: booking.status,
      assigned: assigned.details.booking.status,
      feePaid: ready.feePayment.status,
      paidBooking: ready.status,
      dispatchReady: ready.dispatch.ready,
      dispatchWindow: early ? 'too_early_verified' : 'open',
      driverAcknowledgement: 'verified',
      fleetMismatch: 'verified on initial seed',
      publicBoard: 'verified',
      companies: 3,
    }),
  );
}
try {
  await seed();
} finally {
  await db.end();
}
