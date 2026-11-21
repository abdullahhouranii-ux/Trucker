import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiOrigin,
  signInLocalDemo,
  ApiFailure,
  createClient,
  loadEffectiveCapabilities,
  confirmBrokerReceipt,
  loadBookingDisputes,
  loadBrokerCommissions,
  loadBrokerPayments,
  uploadDisputePhoto,
  loadBookingSummary,
  loadOrganisationShipment,
  loadOrganisationShipments,
  recordPhotoPath,
  loadAuthorities,
  loadArrangedQuotations,
  loadShipmentParties,
  saveShipmentParties,
  publishShipment,
  withdrawShipment,
  createShipmentDraft,
  updateShipmentDraft,
  loadShipmentCountries,
  loadMobileQuotation,
  loadShipmentQuotationTerms,
  saveShipmentQuotationTerms,
  acceptShipmentQuotation,
  rejectShipmentQuotation,
  loadCarrierQuotations,
  withdrawCarrierQuotation,
  reportDriverEstimate,
  loadShipmentBookingPreview,
  submitMobileQuotation,
  loadPublicationCatalogues,
  requestAuthority,
  endAuthority,
  decideAuthority,
  loadCommissionContracts,
  proposeCommissionContract,
  changeCommissionContract,
} from './client.ts';

test('release configuration requires HTTPS and rejects embedded credentials', () => {
  assert.equal(apiOrigin('https://api.example.test', false), 'https://api.example.test');
  assert.throws(() => apiOrigin('http://api.example.test', false));
  assert.throws(() => apiOrigin('https://user:password@api.example.test', true));
  assert.throws(() => apiOrigin('https://api.example.test/other', false));
  assert.equal(apiOrigin('http://10.0.2.2:3000', true), 'http://10.0.2.2:3000');
});
test('session tokens stay in headers; no development-code bypass is requested', async () => {
  let headers: HeadersInit | undefined;
  const request = createClient('https://api.example.test', async (_url, init) => {
    headers = init?.headers;
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({ ok: true }));
  });
  await request('/me', { token: 'private-token', key: 'stable-retry-key' });
  const found = new Headers(headers);
  assert.equal(found.get('authorization'), 'Bearer private-token');
  assert.equal(found.get('idempotency-key'), 'stable-retry-key');
  assert.equal(found.get('x-trucker-development-code'), null);
});
test('lost response is unknown, never success or a false sign-out', async () => {
  const request = createClient('https://api.example.test', async () => {
    throw new Error('lost');
  });
  await assert.rejects(
    request('/auth/sign-out', { method: 'POST' }),
    (error) => error instanceof ApiFailure && error.status === 0 && error.code === 'unconfirmed',
  );
});
test('confirmed revocation and expired sessions remain distinguishable', async () => {
  const ok = createClient(
    'https://api.example.test',
    async () => new Response(null, { status: 204 }),
  );
  assert.equal(await ok('/auth/sign-out', { method: 'POST' }), undefined);
  const expired = createClient(
    'https://api.example.test',
    async () => new Response('{"code":"unauthorized"}', { status: 401 }),
  );
  await assert.rejects(
    expired('/me'),
    (error) => error instanceof ApiFailure && error.status === 401,
  );
});

test('POD upload sends exact bytes and the declared media type, not JSON', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
  const request = createClient('https://api.example.test', async (_url, init) => {
    assert.equal(init?.method, 'PUT');
    assert.equal(new Headers(init?.headers).get('content-type'), 'image/png');
    assert.equal(init?.body, bytes);
    return new Response('{"outcome":"received"}');
  });
  assert.deepEqual(
    await request('/me/driver/assignments/id/pod/items/item', {
      method: 'PUT',
      bytes,
      mediaType: 'image/png',
    }),
    { outcome: 'received' },
  );
});

test('a provider error is preserved as an error and external paths are refused', async () => {
  const request = createClient(
    'https://api.example.test',
    async () => new Response('{"code":"record_changed"}', { status: 409 }),
  );
  await assert.rejects(
    request('/me'),
    (error) =>
      error instanceof ApiFailure && error.status === 409 && error.code === 'record_changed',
  );
  await assert.rejects(request('//elsewhere.example/me'));
});

test('the booking summary tolerates a hidden draft but preserves session expiry', async () => {
  const org = 'a0000000-0000-4000-8000-000000000000';
  const booking = 'b0000000-0000-4000-8000-000000000000';
  const request = createClient('https://api.example.test', async (url, init) => {
    const path = new URL(url as string).pathname;
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
    assert.ok(path.startsWith(`/organisations/${org}/bookings/${booking}/`));
    return path.endsWith('/closure')
      ? Response.json({ state: 'review_required' })
      : Response.json({ code: 'not_found' }, { status: 404 });
  });
  assert.deepEqual(await loadBookingSummary(request, org, booking, 'scoped'), {
    closure: { state: 'review_required' },
    invoice: null,
  });
  const expired = createClient('https://api.example.test', async () =>
    Response.json({ code: 'unauthorized' }, { status: 401 }),
  );
  await assert.rejects(
    loadBookingSummary(expired, org, booking, 'scoped'),
    (error) => error instanceof ApiFailure && error.status === 401,
  );
});

test('code request throttling preserves the server wait without exposing arbitrary error details', async () => {
  const request = createClient('https://api.example.test', async () =>
    Response.json(
      { code: 'too_many_code_requests', details: { retryAfterSeconds: 75, private: 'ignored' } },
      { status: 429 },
    ),
  );
  await assert.rejects(
    request('/auth/code-requests', { method: 'POST' }),
    (error) =>
      error instanceof ApiFailure &&
      error.code === 'too_many_code_requests' &&
      error.retryAfterSeconds === 75 &&
      !('details' in error),
  );
});

test('organisation shipments request all statuses and pass pagination through the scoped route', async () => {
  const org = 'a0000000-0000-4000-8000-000000000000';
  const next = 'b0000000-0000-4000-8000-000000000000';
  const paths: URL[] = [];
  const request = createClient('https://api.example.test', async (url, init) => {
    paths.push(new URL(url as string));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
    return Response.json({ shipments: [], nextAfter: paths.length === 1 ? next : null });
  });
  const first = await loadOrganisationShipments(request, org, 'scoped');
  assert.equal(first.nextAfter, next);
  const second = await loadOrganisationShipments(
    request,
    org,
    'scoped',
    first.nextAfter ?? undefined,
  );
  assert.equal(second.nextAfter, null);
  assert.deepEqual(
    paths.map((url) => [
      url.pathname,
      url.searchParams.get('status'),
      url.searchParams.get('after'),
    ]),
    [
      ['/organisations/' + org + '/shipments', 'all', null],
      ['/organisations/' + org + '/shipments', 'all', next],
    ],
  );
});

test('shipment details use the selected organisation and preserve a refused read', async () => {
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(new URL(url as string).pathname, '/organisations/company/shipments/shipment');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
    return Response.json({ code: 'not_found' }, { status: 404 });
  });
  await assert.rejects(
    loadOrganisationShipment(request, 'company', 'shipment', 'scoped'),
    (error) => error instanceof ApiFailure && error.status === 404,
  );
});

test('broker visibility requires an effective organise capability scoped to the selected company', async () => {
  for (const effective of [false, true]) {
    const request = createClient('https://api.example.test', async (url, init) => {
      assert.equal(new URL(url as string).pathname, '/organisations/company/verification');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
      return Response.json({
        verification: {
          capabilities: [
            { capability: 'carry_as_owner_operator', effective: true },
            { capability: 'organise', effective },
          ],
        },
      });
    });
    assert.equal(
      (await loadEffectiveCapabilities(request, 'company', 'scoped')).includes('organise'),
      effective,
    );
  }
});

test('dispute photo reads and uploads stay scoped to the booking and submit bytes with a stable key', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71]).buffer;
  const base = '/organisations/company/bookings/booking/disputes';
  const request = createClient('https://api.example.test', async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    const pathname = new URL(url as string).pathname;
    if (init?.method === 'GET') {
      assert.equal(pathname, base);
      return Response.json({
        disputes: [{ id: 'case', description: 'Photo requested', events: [] }],
      });
    }
    assert.equal(init?.method, 'PUT');
    assert.equal(pathname, base + '/case/evidence');
    assert.equal(headers.get('content-type'), 'image/png');
    assert.equal(headers.get('idempotency-key'), 'stable-dispute-photo-key');
    assert.equal(init.body, bytes);
    return Response.json({ outcome: 'recorded' });
  });
  const [dispute] = await loadBookingDisputes(request, 'company', 'booking', 'scoped');
  assert.equal(dispute?.id, 'case');
  await uploadDisputePhoto(
    request,
    'company',
    'booking',
    'case',
    'scoped',
    'stable-dispute-photo-key',
    'image/png',
    bytes,
  );
});

test('the broker view uses organisation-scoped commission records and excludes carrier entries', async () => {
  const valid = { currency: 'XTS', commission: '2.50', role: 'organiser' };
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(new URL(url as string).pathname, '/organisations/company/commissions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
    return Response.json({
      commissions: {
        bookings: [
          { ...valid, bookingId: 'one' },
          { ...valid, bookingId: 'two', role: 'carrier' },
        ],
        quotations: [{ ...valid, quotationId: 'three' }],
      },
    });
  });
  assert.deepEqual(await loadBrokerCommissions(request, 'company', 'scoped'), {
    bookings: [{ ...valid, bookingId: 'one' }],
    quotations: [{ ...valid, quotationId: 'three' }],
  });
});

test('broker payment detail reads only the commission payable to that organisation', async () => {
  const payment = { id: 'payment', amount: '2.50', reference: 'fixture', status: 'report' };
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(
      new URL(url as string).pathname,
      '/organisations/company/bookings/booking/financial-completion',
    );
    assert.equal(init?.method, 'GET');
    return Response.json({
      recordingOpen: true,
      obligations: [
        { kind: 'freight', side: 'payee', currency: 'XTS', payments: [] },
        { kind: 'commission', side: 'payer', currency: 'XTS', payments: [] },
        { kind: 'commission', side: 'payee', currency: 'XTS', payments: [payment] },
      ],
    });
  });
  assert.deepEqual(await loadBrokerPayments(request, 'company', 'booking', 'scoped'), {
    recordingOpen: true,
    currency: 'XTS',
    payments: [payment],
  });
});

test('broker receipt confirmation submits the exact payment and stable retry key', async () => {
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(
      new URL(url as string).pathname,
      '/organisations/company/bookings/booking/financial-completion',
    );
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    assert.equal(headers.get('idempotency-key'), 'commission-retry-key');
    assert.deepEqual(JSON.parse(String(init.body)), { action: 'confirm', paymentId: 'payment' });
    return Response.json({ paymentId: 'payment' });
  });
  assert.deepEqual(
    await confirmBrokerReceipt(
      request,
      'company',
      'booking',
      'scoped',
      'payment',
      'commission-retry-key',
    ),
    { paymentId: 'payment' },
  );
});

test('vehicle photos are scoped to the owning company and vehicle', async () => {
  const path = recordPhotoPath('company-a', 'vehicles', 'vehicle-b');
  assert.equal(path, '/organisations/company-a/vehicles/vehicle-b/photos');
  const bytes = Uint8Array.from([255, 216, 255, 217]).buffer;
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(new URL(url as string).pathname, path + '/photo-c');
    assert.equal(init?.method, 'PUT');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
    assert.equal(new Headers(init?.headers).get('content-type'), 'image/jpeg');
    assert.deepEqual(init?.body, bytes);
    return Response.json({ id: 'photo-c' });
  });
  assert.deepEqual(
    await request(path + '/photo-c', {
      token: 'scoped',
      method: 'PUT',
      mediaType: 'image/jpeg',
      bytes,
    }),
    { id: 'photo-c' },
  );
});

test('broker authority requests and endings match the company-scoped API contract', async () => {
  const calls: unknown[] = [];
  const overview = { organiser: true, authorities: [] };
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
    calls.push([new URL(url as string).pathname, init?.method, init?.body]);
    return Response.json({ overview, outcome: 'ok' });
  });
  assert.deepEqual(await loadAuthorities(request, 'broker', 'scoped'), overview);
  await requestAuthority(request, 'broker', 'scoped', 'CUSTOMER-1');
  await endAuthority(request, 'broker', 'scoped', 'mandate', 3);
  assert.deepEqual(calls, [
    ['/organisations/broker/authorities', 'GET', undefined],
    ['/organisations/broker/authorities', 'POST', JSON.stringify({ customerCode: 'CUSTOMER-1' })],
    ['/organisations/broker/authorities/mandate/end', 'POST', JSON.stringify({ version: 3 })],
  ]);
});

test('customer decisions send the exact permissions and version', async () => {
  const bodies: unknown[] = [];
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(
      new URL(url as string).pathname,
      '/organisations/customer/authorities/mandate/decision',
    );
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ outcome: 'ok' });
  });
  await decideAuthority(request, 'customer', 'scoped', 'mandate', 4, {
    decision: 'accept',
    mayPublish: false,
    feePayerAgreed: true,
  });
  await decideAuthority(request, 'customer', 'scoped', 'mandate', 5, { decision: 'decline' });
  assert.deepEqual(bodies, [
    { version: 4, decision: 'accept', mayPublish: false, feePayerAgreed: true },
    { version: 5, decision: 'decline' },
  ]);
});

test('mobile commission contracts keep proposals and versioned decisions company-scoped', async () => {
  const path = '/organisations/company/commission-contracts';
  const calls: unknown[] = [];
  const contracts = {
    organiser: true,
    contracts: [],
    limits: { maxBasisPoints: 2000, settlementMaxDays: 60 },
  };
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
    calls.push([
      new URL(url as string).pathname,
      init?.method,
      init?.body ? JSON.parse(String(init.body)) : null,
    ]);
    return Response.json({ contracts, outcome: 'ok' });
  });
  assert.deepEqual(await loadCommissionContracts(request, 'company', 'scoped'), contracts);
  const proposal = {
    carrierCode: 'CARRIER',
    settlementDays: 14,
    option: 'fixed',
    amount: '12.500',
    currency: 'OMR',
  } as const;
  await proposeCommissionContract(request, 'company', 'scoped', proposal);
  await changeCommissionContract(request, 'company', 'scoped', 'contract', 1, 'accept');
  await changeCommissionContract(request, 'company', 'scoped', 'contract', 2, 'end');
  assert.deepEqual(calls, [
    [path, 'GET', null],
    [path, 'POST', proposal],
    [path + '/contract/decision', 'POST', { version: 1, decision: 'accept' }],
    [path + '/contract/end', 'POST', { version: 2 }],
  ]);
});

test('arranged quotation reads use the acting company and preserve a denied read', async () => {
  const request = createClient('https://api.example.test', async (url, init) => {
    const path = new URL(url as string).pathname;
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
    assert.equal(init?.method, 'GET');
    if (path === '/organisations/broker/shipments/known/quotations') {
      return Response.json({ quotations: { quotations: [{ id: 'quote', currentVersion: 2 }] } });
    }
    assert.equal(path, '/organisations/broker/shipments/other/quotations');
    return Response.json({ code: 'not_found' }, { status: 404 });
  });
  assert.deepEqual(await loadArrangedQuotations(request, 'broker', 'scoped', 'known'), [
    { id: 'quote', currentVersion: 2 },
  ]);
  await assert.rejects(
    loadArrangedQuotations(request, 'broker', 'scoped', 'other'),
    (error) => error instanceof ApiFailure && error.status === 404,
  );
});

test('shipment role updates use the selected company, draft version and authorised party choices', async () => {
  const calls: unknown[] = [];
  const view = { editable: true, parties: { authorityId: null }, customers: [] };
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(new URL(url as string).pathname, '/organisations/broker/shipments/draft/parties');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
    calls.push([init?.method, init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json({ ...view, outcome: 'saved' });
  });
  assert.equal((await loadShipmentParties(request, 'broker', 'scoped', 'draft')).editable, true);
  const choices = {
    customerAuthorityId: 'authority',
    receiver: { name: 'Receiver' },
    freightPayer: 'receiver',
    feePayer: 'organiser',
  } as const;
  await saveShipmentParties(request, 'broker', 'scoped', 'draft', 7, choices);
  assert.deepEqual(calls, [
    ['GET', null],
    ['POST', { version: 7, sender: 'customer', ...choices }],
  ]);
});

test('publication preserves the exact local deadline, draft version and retry key', async () => {
  const body = {
    version: 3,
    cargoCategory: 'general',
    equipmentType: 'flatbed',
    dangerousGoods: false,
    pickupArea: 'Area A',
    deliveryArea: 'Area B',
    quotationDeadline: { local: '2026-11-24T14:30', offsetMinutes: 240 },
  };
  let attempts = 0;
  const request = createClient('https://api.example.test', async (url, init) => {
    const path = new URL(url as string).pathname;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    if (path === '/organisations/broker/shipment-catalogues') {
      assert.equal(init?.method, 'GET');
      return Response.json({ cargoCategories: [], equipmentTypes: [] });
    }
    assert.equal(path, '/organisations/broker/shipments/draft/publish');
    assert.equal(headers.get('idempotency-key'), 'stable');
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    if (++attempts === 1) throw new TypeError('lost response');
    return Response.json({ shipment: { id: 'draft', status: 'published' }, outcome: 'published' });
  });
  await loadPublicationCatalogues(request, 'broker', 'scoped');
  const publish = () => publishShipment(request, 'broker', 'scoped', 'draft', 'stable', body);
  await assert.rejects(
    publish,
    (error) => error instanceof ApiFailure && error.code === 'unconfirmed',
  );
  assert.equal((await publish()).shipment.status, 'published');
});

test('shipment withdrawal retries the same version and key after a lost response', async () => {
  let attempts = 0;
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(
      new URL(url as string).pathname,
      '/organisations/broker/shipments/shipment/withdraw',
    );
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { version: 5 });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    assert.equal(headers.get('idempotency-key'), 'withdraw-retry');
    if (++attempts === 1) throw new TypeError('lost response');
    return Response.json({
      shipment: { id: 'shipment', status: 'withdrawn' },
      outcome: 'already_withdrawn',
    });
  });
  const withdraw = () =>
    withdrawShipment(request, 'broker', 'scoped', 'shipment', 'withdraw-retry', 5);
  await assert.rejects(
    withdraw,
    (error) => error instanceof ApiFailure && error.code === 'unconfirmed',
  );
  assert.equal((await withdraw()).shipment.status, 'withdrawn');
});

test('local demo is opt-in, loopback only, and uses the existing one-time verification', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body));
    calls++;
    if (path === '/auth/code-requests') {
      assert.equal(headers.get('x-trucker-development-code'), 'local-visitor');
      assert.match(body.phone, /^\+999\d+$/);
      return Response.json({ challengeId: 'challenge', developmentCode: '123456' });
    }
    assert.equal(path, '/auth/code-verifications');
    assert.equal(headers.get('x-trucker-development-code'), null);
    assert.deepEqual(body, { challengeId: 'challenge', code: '123456' });
    return Response.json({ token: 'local-test-session' });
  };
  await assert.rejects(signInLocalDemo('http://127.0.0.1:3000', false, '1', () => 'key', fetcher));
  await assert.rejects(
    signInLocalDemo('http://127.0.0.1:3000', true, undefined, () => 'key', fetcher),
  );
  await assert.rejects(
    signInLocalDemo('https://api.example.test', true, '1', () => 'key', fetcher),
  );
  assert.equal(calls, 0);
  const reply = await signInLocalDemo('http://127.0.0.1:3000', true, '1', () => 'key', fetcher);
  assert.equal(reply.token, 'local-test-session');
  assert.equal(calls, 2);
});

test('draft creation keeps private addresses and local windows on a company-scoped retry', async () => {
  const path = '/organisations/broker/shipments';
  const pickup = {
    countryCode: 'OM',
    timeZone: 'Asia/Muscat',
    address: 'Private pickup',
    from: { local: '2026-11-24T09:00', offsetMinutes: 240 },
    until: { local: '2026-11-24T10:00', offsetMinutes: null },
  };
  const body = {
    shipperReference: 'REF-1',
    cargoDescription: 'Cargo',
    grossWeightKg: '12.5',
    pieces: '2',
    pickup,
    delivery: { ...pickup, address: 'Private delivery' },
  };
  let attempts = 0;
  const request = createClient('https://api.example.test', async (url, init) => {
    const route = new URL(url as string).pathname;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    if (route === '/organisations/broker/shipment-places') {
      assert.equal(init?.method, 'GET');
      return Response.json({ countries: [{ code: 'OM', timeZones: ['Asia/Muscat'] }] });
    }
    assert.equal(route, path);
    assert.equal(init?.method, 'POST');
    assert.equal(headers.get('idempotency-key'), 'draft-retry');
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    if (++attempts === 1) throw new TypeError('lost answer');
    return Response.json({ shipment: { id: 'draft-id', status: 'draft' } });
  });
  assert.equal((await loadShipmentCountries(request, 'broker', 'scoped')).countries[0]?.code, 'OM');
  const create = () => createShipmentDraft(request, 'broker', 'scoped', 'draft-retry', body);
  await assert.rejects(
    create,
    (error) => error instanceof ApiFailure && error.code === 'unconfirmed',
  );
  assert.equal((await create()).id, 'draft-id');
});

test('draft editing sends the full versioned snapshot and preserves a stale-version refusal', async () => {
  const window = { local: '2026-11-24T09:00', offsetMinutes: 240 };
  const pickup = {
    countryCode: 'XA',
    timeZone: 'Etc/GMT-4',
    address: 'Private address',
    accessNotes: 'Keep private notes',
    from: window,
    until: window,
  };
  const body = {
    shipperReference: 'REF-2',
    cargoDescription: 'Updated cargo',
    grossWeightKg: '12.5',
    pieces: '2',
    packaging: 'Crates',
    equipmentNeeded: 'Straps',
    pickup,
    delivery: pickup,
  };
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(new URL(url as string).pathname, '/organisations/broker/shipments/draft-id');
    assert.equal(init?.method, 'PATCH');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    assert.equal(headers.get('idempotency-key'), 'edit-stable');
    assert.deepEqual(JSON.parse(String(init?.body)), { ...body, version: 3 });
    return Response.json({ code: 'shipment_changed' }, { status: 409 });
  });
  await assert.rejects(
    updateShipmentDraft(request, 'broker', 'scoped', 'draft-id', 3, 'edit-stable', body),
    (error) =>
      error instanceof ApiFailure && error.status === 409 && error.code === 'shipment_changed',
  );
});

test('mobile quotations keep fleet eligibility, decimal amounts and commission consent scoped', async () => {
  const path = '/organisations/carrier/discovery/shipments/shipment';
  const body = {
    amount: '1250.50',
    inclusions: { loading: true },
    validUntil: { local: '2026-11-26T12:00' },
    earliestPickup: { local: '2026-11-27T12:00' },
    freight: { methods: ['cash_on_delivery' as const], dueDays: null },
  };
  let submitted = 0;
  const request = createClient('https://api.example.test', async (url, init) => {
    const route = new URL(url as string).pathname;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    if (route === path + '/quotation') return Response.json({ quotation: { fleetMatches: false } });
    assert.equal(route, path + '/quotations');
    assert.equal(init?.method, 'POST');
    if (++submitted === 1) {
      assert.equal(headers.get('idempotency-key'), 'first');
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      return Response.json(
        {
          code: 'commission_acceptance_required',
          details: { commission: '50.00', net: '1200.50' },
        },
        { status: 409 },
      );
    }
    assert.equal(headers.get('idempotency-key'), 'confirmed');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ...body,
      commissionAccepted: { commission: '50.00', net: '1200.50' },
    });
    return Response.json({ quotation: { id: 'quote', status: 'submitted' } });
  });
  assert.equal(
    (await loadMobileQuotation(request, 'carrier', 'scoped', 'shipment')).fleetMatches,
    false,
  );
  await assert.rejects(
    submitMobileQuotation(request, 'carrier', 'scoped', 'shipment', 'first', body),
    (error) => error instanceof ApiFailure && error.commissionFigures?.net === '1200.50',
  );
  assert.equal(
    (
      await submitMobileQuotation(request, 'carrier', 'scoped', 'shipment', 'confirmed', {
        ...body,
        commissionAccepted: { commission: '50.00', net: '1200.50' },
      })
    ).quotation.id,
    'quote',
  );
});

test('shipment quotation currency changes use the current version and stable key', async () => {
  const root = '/organisations/shipper/shipments/published';
  const request = createClient('https://api.example.test', async (url, init) => {
    const path = new URL(url as string).pathname;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    if (path === root + '/quotations') {
      assert.equal(init?.method, 'GET');
      return Response.json({
        quotations: {
          terms: { currency: 'XTS', version: 2, locked: false },
          currencyChoices: [{ code: 'XTS' }],
          inclusionsAvailable: true,
        },
      });
    }
    assert.equal(path, root + '/quotation-terms');
    assert.equal(headers.get('idempotency-key'), 'stable-terms');
    assert.deepEqual(JSON.parse(String(init?.body)), { version: 2, currency: 'XTS' });
    return Response.json({ code: 'quotation_terms_locked' }, { status: 409 });
  });
  assert.equal(
    (await loadShipmentQuotationTerms(request, 'shipper', 'scoped', 'published')).terms?.version,
    2,
  );
  await assert.rejects(
    saveShipmentQuotationTerms(request, 'shipper', 'scoped', 'published', 2, 'XTS', 'stable-terms'),
    (error) => error instanceof ApiFailure && error.code === 'quotation_terms_locked',
  );
});

test('shipper acceptance uses the displayed version, chosen freight method and stable replay key', async () => {
  let submissions = 0;
  const request = createClient('https://api.example.test', async (url, init) => {
    const path = new URL(url as string).pathname;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    if (path === '/organisations/shipper/shipments/shipment/booking') {
      return Response.json({
        booking: null,
        acceptance: [{ quotationId: 'offer', state: 'ok', version: 4 }],
      });
    }
    assert.equal(path, '/organisations/shipper/quotations/offer/accept');
    assert.equal(headers.get('idempotency-key'), 'booking-retry');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      version: 4,
      freightMethod: 'bank_transfer',
    });
    if (++submissions === 1) throw new TypeError('lost answer');
    return Response.json({ booking: { id: 'booking', status: 'awaiting_resources' } });
  });
  assert.equal(
    (await loadShipmentBookingPreview(request, 'shipper', 'scoped', 'shipment')).acceptance[0]
      ?.version,
    4,
  );
  const accept = () =>
    acceptShipmentQuotation(
      request,
      'shipper',
      'scoped',
      'offer',
      4,
      'booking-retry',
      'bank_transfer',
    );
  await assert.rejects(accept, (err) => err instanceof ApiFailure && err.code === 'unconfirmed');
  assert.equal((await accept()).booking.status, 'awaiting_resources');
});

test('shipper rejection uses the scoped quote version and repeats with the original key', async () => {
  let attempts = 0;
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(new URL(url as string).pathname, '/organisations/shipper/quotations/offer/reject');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    assert.equal(headers.get('idempotency-key'), 'reject-retry');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { version: 4 });
    if (++attempts === 1) throw new TypeError('lost reply');
    return Response.json({ outcome: 'already_rejected' });
  });
  const reject = () =>
    rejectShipmentQuotation(request, 'shipper', 'scoped', 'offer', 4, 'reject-retry');
  await assert.rejects(reject, (err) => err instanceof ApiFailure && err.code === 'unconfirmed');
  assert.equal((await reject()).outcome, 'already_rejected');
});

test('carrier withdrawal is scoped to its own quote and preserves the original retry', async () => {
  const base = '/organisations/carrier/quotations';
  const quote = { id: 'offer', status: 'submitted', currentVersion: 2 };
  let writes = 0;
  const request = createClient('https://api.example.test', async (url, init) => {
    const path = new URL(url as string).pathname;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer scoped');
    if (path === base) return Response.json({ quotations: [quote] });
    assert.equal(path, base + '/offer/withdraw');
    assert.equal(init?.method, 'POST');
    assert.equal(headers.get('idempotency-key'), 'same-withdrawal');
    assert.deepEqual(JSON.parse(String(init?.body)), { version: 2 });
    if (++writes === 1) throw new TypeError('lost answer');
    return Response.json({
      outcome: 'already_withdrawn',
      quotation: { ...quote, status: 'withdrawn' },
    });
  });
  assert.equal((await loadCarrierQuotations(request, 'carrier', 'scoped'))[0]?.id, 'offer');
  const withdraw = () =>
    withdrawCarrierQuotation(request, 'carrier', 'scoped', 'offer', 2, 'same-withdrawal');
  await assert.rejects(withdraw, (err) => err instanceof ApiFailure && err.code === 'unconfirmed');
  assert.equal((await withdraw()).quotation.status, 'withdrawn');
});

test('arrival estimates send only the assigned booking and confirmed UTC time', async () => {
  const arrivalAt = '2026-11-21T17:30:00.000Z';
  const request = createClient('https://api.example.test', async (url, init) => {
    assert.equal(
      new URL(url as string).pathname,
      '/me/driver/assignments/assigned-booking/estimate',
    );
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer driver-session');
    assert.deepEqual(JSON.parse(String(init?.body)), { arrivalAt });
    return Response.json({ outcome: 'stated', trip: { estimate: { arrivalAt } } });
  });
  assert.equal(
    (await reportDriverEstimate(request, 'assigned-booking', 'driver-session', arrivalAt)).trip
      .estimate?.arrivalAt,
    arrivalAt,
  );
});
