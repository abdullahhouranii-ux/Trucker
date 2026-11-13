import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** A six-digit code, uniformly random, leading zeros kept. */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Six digits are too few to protect with a plain hash: anyone who can read the table could try
 * all million values. The hash is keyed with a server secret and bound to the challenge, so the
 * table alone reveals nothing.
 */
export function hashCode(secret: string, challengeId: string, code: string): string {
  return createHmac('sha256', secret).update(`code:${challengeId}:${code}`).digest('hex');
}

/**
 * The session token is derived from the session identifier with the server secret, so the same
 * token can be returned again when the sign-in request is safely retried, without ever storing
 * it. The database keeps only a hash of the token.
 */
export function sessionToken(secret: string, sessionId: string): string {
  const mac = createHmac('sha256', secret).update(`session:${sessionId}`).digest('base64url');
  return `${sessionId}.${mac}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
