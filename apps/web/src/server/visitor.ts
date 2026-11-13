// Who is really asking: a browser on this machine, or anyone else.
//
// The web application may pass a development sign-in code to the browser only for a visitor on
// this machine. The API cannot judge that: it only ever sees the web server's own connection.
// So the web server records, the moment a request arrives and before any framework code touches
// it, where the connection came from. Headers the visitor sent are never trusted for this.

/** Set by this server on every request. A value sent by the visitor is always overwritten. */
export const VISITOR_HEADER = 'x-trucker-visitor';
export type VisitorKind = 'local' | 'remote';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Any of these means something passed the request on (a proxy, a tunnel, a load balancer), so
// the connection address is the forwarder's and not the visitor's.
export const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'via',
  'cf-connecting-ip',
  'true-client-ip',
] as const;

type Headers = Record<string, string | string[] | undefined>;

/** True for the names a browser on this machine uses to reach this machine. */
export function isLocalHostName(host: string | string[] | undefined): boolean {
  if (typeof host !== 'string' || host.length === 0) return false;
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : (host.split(':')[0] ?? '');
  const lower = name.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '[::1]' ||
    lower.endsWith('.localhost')
  );
}

/**
 * Classifies a request as it arrives. Local needs all three: the connection comes from this
 * machine, nothing forwarded it, and it was addressed to a local name. Anything else, or
 * anything missing, is remote.
 */
export function classifyArrival(remoteAddress: string | undefined, headers: Headers): VisitorKind {
  if (!remoteAddress || !LOOPBACK_ADDRESSES.has(remoteAddress)) return 'remote';
  if (FORWARDING_HEADERS.some((name) => headers[name] !== undefined)) return 'remote';
  if (!isLocalHostName(headers.host)) return 'remote';
  return 'local';
}

export type DevelopmentCodeSetting = 'none' | 'local-visitors';

/** Reads the web application's own switch. Anything other than the exact value is off. */
export function developmentCodeSetting(
  env: Record<string, string | undefined>,
): DevelopmentCodeSetting {
  return env.TRUCKER_DEVELOPMENT_CODE_DISPLAY === 'local-visitors' ? 'local-visitors' : 'none';
}

export function isProductionStage(env: Record<string, string | undefined>): boolean {
  return env.NEXT_PUBLIC_TRUCKER_STAGE === 'production' || env.TRUCKER_STAGE === 'production';
}

/** Production must not be started with development codes switched on. */
export function assertDevelopmentCodeSettingAllowed(env: Record<string, string | undefined>): void {
  if (isProductionStage(env) && developmentCodeSetting(env) !== 'none')
    throw new Error(
      'TRUCKER_DEVELOPMENT_CODE_DISPLAY must not be set in production: development sign-in codes are for a local machine only.',
    );
}

/**
 * The single decision used everywhere in the web application: may a development code be asked
 * for, kept or shown for this request? Off unless switched on, never in production, and only
 * for a visitor this server itself recorded as local.
 */
export function mayHandleDevelopmentCode(
  env: Record<string, string | undefined>,
  visitor: string | null | undefined,
): boolean {
  if (isProductionStage(env)) return false;
  if (developmentCodeSetting(env) !== 'local-visitors') return false;
  return visitor === 'local';
}
