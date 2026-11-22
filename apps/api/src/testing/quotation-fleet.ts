import { randomBytes } from 'node:crypto';
import type pg from 'pg';

/** Supply a verified matching truck for tests whose setup expects a successful quotation. */
export async function ensureQuotationFleet(
  owner: pg.Pool,
  personId: string,
  organisationId: string,
  shipmentId: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO trucker.vehicle
       (organisation_id, kind, category_code, equipment_type, registration_country,
        registration_number, ownership, ownership_decided_at, created_by, created_at, updated_at)
     SELECT $2, 'truck', 'fictional_rigid_truck', s.equipment_type, s.pickup_country,
            $4, 'verified', now(), $1, now(), now()
     FROM trucker.shipment_draft s
     WHERE s.id = $3 AND NOT trucker.quotation_fleet_matches(s, $2)`,
    [personId, organisationId, shipmentId, randomBytes(8).toString('hex').toUpperCase()],
  );
}
