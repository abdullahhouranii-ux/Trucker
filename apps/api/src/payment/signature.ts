import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signature scheme of the development stand-in, as real providers sign: an HMAC-SHA256 of
 * the timestamp and the raw body, sent as `t=<seconds>,v1=<hex>`. A notice older or newer than
 * the tolerance is refused, so a captured one cannot be replayed later; one replayed within it
 * is stored once by its identifier (payment_report).
 */
export const SIGNATURE_HEADER = 'trucker-test-signature';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function sign(secret: string, rawBody: Buffer | string, at: Date): string {
  const seconds = Math.floor(at.getTime() / 1000);
  const mac = createHmac('sha256', secret).update(`${seconds}.`).update(rawBody).digest('hex');
  return `t=${seconds},v1=${mac}`;
}

export function signatureValid(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  now: Date,
): boolean {
  if (typeof header !== 'string' || header.length > 200) return false;
  const match = /^t=([0-9]{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const seconds = Number(match[1]);
  if (Math.abs(now.getTime() / 1000 - seconds) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${seconds}.`).update(rawBody).digest();
  const given = Buffer.from(match[2]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
