import type pg from 'pg';

/**
 * The protected security settings (db/migrations/0004, trucker.security_setting). They are
 * read and enforced inside the database. The API's role has no right on the table; these
 * helpers are for the migration role, through `npm run db:settings`, and for tests.
 */
export const SECURITY_SETTING_DEFAULTS = {
  code_ttl_seconds: 300,
  code_max_attempts: 5,
  code_resend_wait_seconds: 60,
  code_max_per_hour: 5,
  session_idle_minutes: 30,
  session_absolute_hours: 12,
  organisation_creation_limit: 5,
  shipment_open_draft_limit: 200,
  shipment_page_size: 20,
  retry_key_retention_hours: 24,
  publication_lead_minutes: 120,
  published_shipment_limit: 50,
  discovery_page_size: 20,
  discovery_read_limit: 120,
  discovery_cursor_hours: 2,
  quotation_min_validity_minutes: 15,
  quotation_open_limit: 100,
  quotation_version_limit: 5,
  fleet_vehicle_limit: 200,
  fleet_driver_limit: 200,
  fleet_document_version_limit: 5,
  staff_session_idle_minutes: 15,
  staff_session_absolute_hours: 8,
  staff_failure_limit: 5,
  staff_lock_minutes: 15,
  staff_ticket_seconds: 300,
  staff_enrolment_hours: 24,
} as const;

export type SettingName = keyof typeof SECURITY_SETTING_DEFAULTS;
export const SETTING_NAMES = Object.keys(SECURITY_SETTING_DEFAULTS) as SettingName[];

export type SecuritySettings = Record<SettingName, number> & { reviewed_for_production: boolean };

export async function readSecuritySettings(
  owner: Pick<pg.Pool, 'query'>,
): Promise<SecuritySettings> {
  const found = await owner.query<SecuritySettings>(
    `SELECT ${SETTING_NAMES.join(', ')}, reviewed_for_production FROM trucker.security_setting`,
  );
  if (!found.rows[0]) throw new Error('the security settings row is missing');
  return found.rows[0];
}

/**
 * Parses `name=value` pairs. Only known names and whole numbers are accepted; the allowed
 * range of each is enforced by the table itself.
 */
export function parseSettingChanges(
  pairs: readonly string[],
): Partial<Record<SettingName, number>> {
  const changes: Partial<Record<SettingName, number>> = {};
  for (const pair of pairs) {
    const match = /^([a-z_]+)=([0-9]{1,6})$/.exec(pair);
    const name = match?.[1] as SettingName | undefined;
    if (!match || !name || !SETTING_NAMES.includes(name))
      throw new Error(`not a setting: ${pair} (known: ${SETTING_NAMES.join(', ')})`);
    changes[name] = Number(match[2]);
  }
  return changes;
}

/**
 * Changes settings. Any change withdraws the production review unless the same call records
 * a new one: reviewed values are the ones in the row, not earlier ones.
 */
export async function writeSecuritySettings(
  owner: Pick<pg.Pool, 'query'>,
  changes: Partial<Record<SettingName, number>>,
  reviewedForProduction: boolean,
): Promise<SecuritySettings> {
  const names = SETTING_NAMES.filter((name) => changes[name] !== undefined);
  const assignments = names.map((name, index) => `${name} = $${index + 2}`);
  await owner.query(
    `UPDATE trucker.security_setting
     SET ${[...assignments, 'reviewed_for_production = $1', 'updated_at = now()'].join(', ')}`,
    [reviewedForProduction, ...names.map((name) => changes[name])],
  );
  return readSecuritySettings(owner);
}
