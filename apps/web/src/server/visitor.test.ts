import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertDevelopmentCodeSettingAllowed,
  classifyArrival,
  FORWARDING_HEADERS,
  isLocalHostName,
  mayHandleDevelopmentCode,
} from './visitor.ts';

const on = { TRUCKER_DEVELOPMENT_CODE_DISPLAY: 'local-visitors' };

test('a browser on this machine, addressed by a local name, is local', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
    for (const host of ['localhost:3100', '127.0.0.1:3100', '[::1]:3100', 'trucker.localhost'])
      assert.equal(classifyArrival(address, { host }), 'local', `${address} ${host}`);
});

test('a connection from any other address is remote', () => {
  for (const address of ['192.0.2.2', '10.0.0.5', '::ffff:10.0.0.5', '2001:db8::1', '', undefined])
    assert.equal(classifyArrival(address, { host: 'localhost:3100' }), 'remote', String(address));
});

test('a forwarded request is remote even when the connection is from this machine', () => {
  for (const name of FORWARDING_HEADERS)
    assert.equal(
      classifyArrival('127.0.0.1', { host: 'localhost:3100', [name]: '127.0.0.1' }),
      'remote',
      name,
    );
});

test('a request addressed to a public name is remote even from this machine', () => {
  for (const host of ['trucker.example', 'abc.tunnel.example:443', '192.0.2.2:3100', '', undefined])
    assert.equal(classifyArrival('127.0.0.1', { host }), 'remote', String(host));
  assert.equal(isLocalHostName('localhost.example'), false);
  assert.equal(isLocalHostName('notlocalhost'), false);
});

test('a development code is handled only when switched on, for a local visitor', () => {
  assert.equal(mayHandleDevelopmentCode(on, 'local'), true);
  assert.equal(mayHandleDevelopmentCode(on, 'remote'), false);
  assert.equal(mayHandleDevelopmentCode(on, null), false, 'no record of the visitor means no');
  assert.equal(mayHandleDevelopmentCode(on, undefined), false);
  assert.equal(mayHandleDevelopmentCode({}, 'local'), false, 'off by default');
  assert.equal(
    mayHandleDevelopmentCode({ TRUCKER_DEVELOPMENT_CODE_DISPLAY: 'true' }, 'local'),
    false,
    'only the exact value switches it on',
  );
});

test('production never handles a development code and refuses to start with the switch on', () => {
  for (const stage of [
    { NEXT_PUBLIC_TRUCKER_STAGE: 'production' },
    { TRUCKER_STAGE: 'production' },
  ]) {
    assert.equal(mayHandleDevelopmentCode({ ...on, ...stage }, 'local'), false);
    assert.throws(() => assertDevelopmentCodeSettingAllowed({ ...on, ...stage }), /production/);
    assert.doesNotThrow(() => assertDevelopmentCodeSettingAllowed(stage));
  }
  assert.doesNotThrow(() => assertDevelopmentCodeSettingAllowed(on));
});
