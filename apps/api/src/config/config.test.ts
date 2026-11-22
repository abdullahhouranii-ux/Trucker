import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from './config.js';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://app:s3cret-value@localhost:5432/trucker',
};

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail('expected configuration to be refused');
}

test('accepts a valid configuration and applies defaults', () => {
  const config = loadConfig(valid);
  assert.equal(config.PORT, 3000);
  assert.equal(config.DB_POOL_MAX, 10);
  assert.equal(config.NODE_ENV, 'test');
});

test('refuses a missing DATABASE_URL and names the key', () => {
  const problems = problemsOf({ NODE_ENV: 'test' });
  assert.ok(problems.some((p) => p.startsWith('DATABASE_URL ')));
});

test('refuses a missing NODE_ENV: there is no silent default environment', () => {
  const problems = problemsOf({ DATABASE_URL: valid.DATABASE_URL });
  assert.ok(problems.some((p) => p.startsWith('NODE_ENV ')));
});

test('refuses a malformed PORT and an out-of-range pool size together', () => {
  const problems = problemsOf({ ...valid, PORT: 'eighty', DB_POOL_MAX: '0' });
  assert.ok(problems.some((p) => p.startsWith('PORT ')));
  assert.ok(problems.some((p) => p.startsWith('DB_POOL_MAX ')));
});

test('never echoes a configured value in the error', () => {
  try {
    loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'mysql://app:s3cret-value@localhost/x' });
    assert.fail('expected configuration to be refused');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.ok(!error.message.includes('s3cret-value'));
    assert.ok(!error.message.includes('mysql'));
    assert.ok(error.problems.some((p) => p.startsWith('DATABASE_URL must be')));
  }
});

test('the returned configuration cannot be modified', () => {
  const config = loadConfig(valid);
  assert.throws(() => {
    (config as { PORT: number }).PORT = 1;
  });
});

test('the payment stand-in is closed by default, refused in production and with a remote database', () => {
  assert.equal(loadConfig(valid).PAYMENT_PROVIDER, 'none');
  assert.equal(loadConfig({ ...valid, PAYMENT_PROVIDER: 'test' }).PAYMENT_PROVIDER, 'test');
  assert.ok(
    problemsOf({ ...valid, NODE_ENV: 'production', PAYMENT_PROVIDER: 'test' }).includes(
      'PAYMENT_PROVIDER must not be test in production',
    ),
  );
  assert.ok(
    problemsOf({
      ...valid,
      DATABASE_URL: 'postgres://app:s3cret-value@db.example.test:5432/trucker',
      PAYMENT_PROVIDER: 'test',
    }).includes('PAYMENT_PROVIDER test needs a database on this machine'),
  );
  assert.ok(
    problemsOf({ ...valid, PAYMENT_PROVIDER: 'card' }).some((p) =>
      p.startsWith('PAYMENT_PROVIDER '),
    ),
  );
});
