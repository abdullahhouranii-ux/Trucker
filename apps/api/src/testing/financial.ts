import type pg from 'pg';

export interface FinancialChanges {
  readonly feeBasisPoints?: number;
  readonly freightDueDays?: number;
  readonly commissionOptions?: readonly string[];
  readonly commissionMaxBasisPoints?: number;
  readonly commissionSettlementMaxDays?: number;
  readonly feePaymentHours?: number;
}

/**
 * Tests only, as the migration role: puts a version of the financial settings in force at the
 * test clock's present, copying the version in force with these changes. It is marked as a
 * development default, which the database refuses in a production database. Staff draft and
 * approve real versions through the API (staff/finance.test.ts).
 */
export async function setFinancialSettings(
  owner: Pick<pg.Pool, 'query'>,
  changes: FinancialChanges,
): Promise<void> {
  await owner.query(
    `INSERT INTO trucker.financial_setting_version
       (status, development_default, fee_basis_points, commission_options, commission_max_basis_points,
        commission_settlement_max_days, freight_due_days, fee_payment_hours, note, effective_at, drafted_at)
     SELECT 'approved', true, coalesce($1, f.fee_basis_points), coalesce($2::text[], f.commission_options),
            coalesce($3, f.commission_max_basis_points), coalesce($4, f.commission_settlement_max_days),
            coalesce($5, f.freight_due_days), coalesce($6, f.fee_payment_hours), 'Test settings',
            trucker.clock_now(), trucker.clock_now()
     FROM trucker.financial_settings_at(trucker.clock_now()) f`,
    [
      changes.feeBasisPoints ?? null,
      changes.commissionOptions ?? null,
      changes.commissionMaxBasisPoints ?? null,
      changes.commissionSettlementMaxDays ?? null,
      changes.freightDueDays ?? null,
      changes.feePaymentHours ?? null,
    ],
  );
}

/** Tests only: the values of the migration's development default in force again. */
export async function restoreFinancialSettings(owner: Pick<pg.Pool, 'query'>): Promise<void> {
  await owner.query(
    `INSERT INTO trucker.financial_setting_version
       (status, development_default, fee_basis_points, commission_options, commission_max_basis_points,
        commission_settlement_max_days, freight_due_days, fee_payment_hours, note, effective_at, drafted_at)
     SELECT 'approved', true, d.fee_basis_points, d.commission_options, d.commission_max_basis_points,
            d.commission_settlement_max_days, d.freight_due_days, d.fee_payment_hours, 'Test settings restored',
            trucker.clock_now(), trucker.clock_now()
     FROM trucker.financial_setting_version d
     WHERE d.development_default ORDER BY d.version_no LIMIT 1`,
  );
}
