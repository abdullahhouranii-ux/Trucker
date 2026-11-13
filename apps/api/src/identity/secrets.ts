import { createHash, createHmac } from 'node:crypto';

/**
 * One-time codes are created and compared inside the database (db/migrations/0004). The API
 * never sees a stored code hash. What it contributes is this key: the database keys each
 * stored hash with it and never keeps it, so the tables alone, read by anyone, reveal no
 * code. Six digits are too few to protect with an unkeyed hash, salted or not: anyone who
 * could read the table could try all million values.
 *
 * It is derived from the server secret rather than being the secret itself, so the value
 * that travels to the database cannot be used to forge a session token.
 */
export function codePepper(secret: string): string {
  return createHmac('sha256', secret).update('trucker:sign-in-code-pepper:v1').digest('hex');
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
