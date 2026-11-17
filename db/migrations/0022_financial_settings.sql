-- 0022_financial_settings
-- Financial settings, versioned (slice 24; model: docs/specs/ADR_001_COMMERCIAL_MODEL.md, R-16,
-- R-17, R-18, G-7). Every financial setting is a version: a staff administrator drafts it with
-- a reason and an effective time, a different administrator approves it, and from its
-- effective time it is the version in force. A version is never changed once written; a draft
-- is discarded and a new one made, and an approved version not yet in force can be withdrawn.
-- Each booking records the version it was made under, and keeps its figures whatever later
-- versions say.
--
-- What the versions hold now: Trucker's fee (method, basis points, rounding), the commission
-- options open to organisers and their limits, and the freight due days. The fee payer, the
-- fee deadline and refunds join later slices. The two booking settings that lived in
-- security_setting move here and are removed there.
--
-- In development a default version, marked as such, is in force from the start. A production
-- start is refused until an approved version is in force (checked by the API at start).
--
-- Order of locks: a booking takes the settings lock shared, an approval or a withdrawal takes it
-- exclusively, each before reading the clock. A booking accepted at the moment a version takes
-- effect therefore uses exactly the version in force at its acceptance time.

CREATE TABLE trucker.financial_setting_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_no integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'discarded', 'withdrawn')),
  development_default boolean NOT NULL DEFAULT false,
  -- Trucker's fee.
  fee_method text NOT NULL DEFAULT 'percentage_of_shipping_price'
    CHECK (fee_method IN ('percentage_of_shipping_price')),
  fee_basis_points integer NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 5000),
  fee_rounding text NOT NULL DEFAULT 'half_up' CHECK (fee_rounding IN ('half_up')),
  -- Organiser commissions.
  commission_options text[] NOT NULL
    CHECK (commission_options <@ ARRAY['percentage', 'fixed', 'contract']::text[]
           AND array_position(commission_options, NULL) IS NULL),
  commission_max_basis_points integer NOT NULL CHECK (commission_max_basis_points BETWEEN 1 AND 5000),
  commission_settlement_max_days integer NOT NULL CHECK (commission_settlement_max_days BETWEEN 1 AND 365),
  -- Freight, paid to the carrier.
  freight_due_days integer NOT NULL CHECK (freight_due_days BETWEEN 0 AND 365),
  -- Why, and when.
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
  effective_from timestamptz,
  effective_at timestamptz,
  draft_key text UNIQUE,
  draft_hash text,
  drafted_by uuid REFERENCES trucker.staff_account (id),
  drafted_at timestamptz NOT NULL,
  approved_by uuid REFERENCES trucker.staff_account (id),
  approved_at timestamptz,
  closed_by uuid REFERENCES trucker.staff_account (id),
  closed_at timestamptz,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT financial_setting_default CHECK (
    (development_default AND status = 'approved' AND drafted_by IS NULL AND approved_by IS NULL
     AND draft_key IS NULL AND effective_at IS NOT NULL)
    OR (NOT development_default AND drafted_by IS NOT NULL AND draft_key IS NOT NULL AND draft_hash IS NOT NULL)),
  CONSTRAINT financial_setting_approved CHECK (
    (status IN ('approved', 'withdrawn')) = (effective_at IS NOT NULL)
    AND (development_default OR (status IN ('approved', 'withdrawn')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL))),
  CONSTRAINT financial_setting_two_people CHECK (approved_by IS NULL OR approved_by <> drafted_by),
  CONSTRAINT financial_setting_closed CHECK ((status IN ('discarded', 'withdrawn')) = (closed_at IS NOT NULL))
);
CREATE INDEX financial_setting_in_force_idx ON trucker.financial_setting_version (effective_at DESC, version_no DESC)
  WHERE status = 'approved';
ALTER TABLE trucker.financial_setting_version ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.financial_setting_version FROM trucker_app, PUBLIC;

-- What may change: only the status, by one of three moves, with who and when. The values of a
-- version never change. A default version may be added only outside production.
CREATE FUNCTION trucker.guard_financial_setting() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.development_default AND (SELECT e.kind FROM trucker.environment e) = 'production' THEN
      RAISE EXCEPTION 'a development default is never added to a production database' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT NEW.development_default AND NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a financial setting version is written as a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a financial setting version is never changed or removed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.version_no, NEW.development_default, NEW.fee_method, NEW.fee_basis_points, NEW.fee_rounding,
      NEW.commission_options, NEW.commission_max_basis_points, NEW.commission_settlement_max_days,
      NEW.freight_due_days, NEW.note, NEW.effective_from, NEW.draft_key, NEW.draft_hash, NEW.drafted_by,
      NEW.drafted_at)
     IS DISTINCT FROM
     (OLD.id, OLD.version_no, OLD.development_default, OLD.fee_method, OLD.fee_basis_points, OLD.fee_rounding,
      OLD.commission_options, OLD.commission_max_basis_points, OLD.commission_settlement_max_days,
      OLD.freight_due_days, OLD.note, OLD.effective_from, OLD.draft_key, OLD.draft_hash, OLD.drafted_by,
      OLD.drafted_at)
     OR NOT ((OLD.status = 'draft' AND NEW.status IN ('approved', 'discarded'))
             OR (OLD.status = 'approved' AND NEW.status = 'withdrawn'
                 AND NEW.effective_at = OLD.effective_at AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by
                 AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at
                 AND trucker.clock_now() < OLD.effective_at)) THEN
    RAISE EXCEPTION 'a financial setting version is never changed or removed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER financial_setting_guard BEFORE INSERT OR UPDATE OR DELETE ON trucker.financial_setting_version
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_financial_setting();
CREATE TRIGGER financial_setting_truncate_guard BEFORE TRUNCATE ON trucker.financial_setting_version
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_financial_setting();

-- The development default: the values the booking settings had, the commission limits of
-- slices 23 and 23b. Never approved for production.
INSERT INTO trucker.financial_setting_version
  (status, development_default, fee_basis_points, commission_options, commission_max_basis_points,
   commission_settlement_max_days, freight_due_days, note, effective_at, drafted_at)
SELECT 'approved', true, g.booking_fee_basis_points, ARRAY['percentage', 'fixed', 'contract'], 2500, 60,
       g.booking_payment_due_days,
       'Development default (ADR-001 D-3, D-4, D-9). Not approved for production.', '-infinity', now()
FROM trucker.security_setting g;

-- The version in force at a moment.
CREATE FUNCTION trucker.financial_settings_at(p_at timestamptz) RETURNS trucker.financial_setting_version
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT v.* FROM trucker.financial_setting_version v
  WHERE v.status = 'approved' AND v.effective_at <= p_at
  ORDER BY v.effective_at DESC, v.version_no DESC
  LIMIT 1
$$;

-- Whether an approved version, not a development default, is in force. Read when a production
-- API starts.
CREATE FUNCTION trucker.financial_settings_ready() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(NOT (trucker.financial_settings_at(trucker.clock_now())).development_default, false)
$$;

CREATE FUNCTION trucker.financial_setting_values(v trucker.financial_setting_version, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', v.id, 'versionNo', v.version_no, 'version', v.row_version, 'status', v.status,
    'state', CASE WHEN v.status <> 'approved' THEN v.status
                  WHEN v.id = (trucker.financial_settings_at(p_at)).id THEN 'in_force'
                  WHEN v.effective_at > p_at THEN 'scheduled'
                  ELSE 'superseded' END,
    'developmentDefault', v.development_default,
    'feeMethod', v.fee_method, 'feeBasisPoints', v.fee_basis_points, 'feeRounding', v.fee_rounding,
    'commissionOptions', to_jsonb(v.commission_options),
    'commissionMaxBasisPoints', v.commission_max_basis_points,
    'commissionSettlementMaxDays', v.commission_settlement_max_days,
    'freightDueDays', v.freight_due_days,
    'note', v.note,
    'effectiveFrom', v.effective_from,
    'effectiveAt', CASE WHEN v.effective_at = '-infinity' THEN NULL ELSE v.effective_at END,
    'draftedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                  FROM trucker.staff_account a WHERE a.id = v.drafted_by),
    'draftedAt', v.drafted_at,
    'approvedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                   FROM trucker.staff_account a WHERE a.id = v.approved_by),
    'approvedAt', v.approved_at,
    'closedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                 FROM trucker.staff_account a WHERE a.id = v.closed_by),
    'closedAt', v.closed_at)
$$;

-- The problems with a draft, if any.
--   p_content: {"feeBasisPoints": int, "commissionOptions": [text], "commissionMaxBasisPoints": int,
--               "commissionSettlementMaxDays": int, "freightDueDays": int, "note": text,
--               "effectiveFrom": text | null}
CREATE FUNCTION trucker.financial_setting_problems(p_content jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  problems jsonb := '[]'::jsonb;
  field text;
  bounds integer[];
  v_from timestamptz;
BEGIN
  FOR field, bounds IN
    SELECT * FROM (VALUES ('feeBasisPoints', ARRAY[0, 5000]), ('commissionMaxBasisPoints', ARRAY[1, 5000]),
                          ('commissionSettlementMaxDays', ARRAY[1, 365]), ('freightDueDays', ARRAY[0, 365])) f
  LOOP
    IF jsonb_typeof(p_content -> field) IS DISTINCT FROM 'number'
       OR (p_content ->> field) !~ '^[0-9]{1,4}$'
       OR (p_content ->> field)::integer NOT BETWEEN bounds[1] AND bounds[2] THEN
      problems := problems || jsonb_build_object('field', field, 'code', 'out_of_range');
    END IF;
  END LOOP;
  IF jsonb_typeof(p_content -> 'commissionOptions') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_content -> 'commissionOptions') e
                WHERE jsonb_typeof(e) <> 'string' OR e #>> '{}' NOT IN ('percentage', 'fixed', 'contract'))
     OR (SELECT count(*) <> count(DISTINCT e) FROM jsonb_array_elements(p_content -> 'commissionOptions') e) THEN
    problems := problems || jsonb_build_object('field', 'commissionOptions', 'code', 'invalid');
  END IF;
  IF jsonb_typeof(p_content -> 'note') IS DISTINCT FROM 'string'
     OR char_length(btrim(p_content ->> 'note')) NOT BETWEEN 1 AND 1000 THEN
    problems := problems || jsonb_build_object('field', 'note', 'code', 'required');
  END IF;
  IF jsonb_typeof(p_content -> 'effectiveFrom') = 'string' THEN
    IF (p_content ->> 'effectiveFrom') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      problems := problems || jsonb_build_object('field', 'effectiveFrom', 'code', 'invalid');
    ELSE
      BEGIN
        v_from := (p_content ->> 'effectiveFrom')::timestamptz;
        IF v_from <= p_at THEN
          problems := problems || jsonb_build_object('field', 'effectiveFrom', 'code', 'passed');
        END IF;
      EXCEPTION WHEN OTHERS THEN
        problems := problems || jsonb_build_object('field', 'effectiveFrom', 'code', 'invalid');
      END;
    END IF;
  ELSIF p_content ? 'effectiveFrom' AND jsonb_typeof(p_content -> 'effectiveFrom') <> 'null' THEN
    problems := problems || jsonb_build_object('field', 'effectiveFrom', 'code', 'invalid');
  END IF;
  RETURN problems;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff commands. Each needs staff_admin and records what it did or refused.
-- ---------------------------------------------------------------------------------------------

-- Every version, newest first, with the one in force.
--   status: ok | unauthorized | forbidden
CREATE FUNCTION trucker.staff_financial_settings(p_token_hash text, p_request_id text, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.financial_settings', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  detail := jsonb_build_object(
    'now', entered.at,
    'inForce', trucker.financial_setting_values(trucker.financial_settings_at(entered.at), entered.at),
    'versions', coalesce((SELECT jsonb_agg(trucker.financial_setting_values(v, entered.at) ORDER BY v.version_no DESC)
                          FROM trucker.financial_setting_version v), '[]'::jsonb));
END
$$;

-- A new draft. The same request again with the same key makes nothing more.
--   status: drafted | repeated | key_conflict | invalid | unauthorized | forbidden
CREATE FUNCTION trucker.staff_financial_draft(
  p_token_hash text, p_key text, p_content jsonb, p_request_id text, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  v trucker.financial_setting_version;
  hash text := trucker.content_hash(coalesce(p_content, '{}'::jsonb));
  problems jsonb;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.financial_setting.draft', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'retryKey', 'code', 'invalid'));
    RETURN;
  END IF;
  SELECT * INTO v FROM trucker.financial_setting_version x WHERE x.draft_key = p_key;
  IF FOUND THEN
    status := CASE WHEN v.drafted_by = entered.staff_id AND v.draft_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.financial_setting_values(v, entered.at) END;
    RETURN;
  END IF;
  problems := trucker.financial_setting_problems(coalesce(p_content, '{}'::jsonb), entered.at);
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.financial_setting_version
      (status, fee_basis_points, commission_options, commission_max_basis_points, commission_settlement_max_days,
       freight_due_days, note, effective_from, draft_key, draft_hash, drafted_by, drafted_at)
    VALUES ('draft', (p_content ->> 'feeBasisPoints')::integer,
            ARRAY(SELECT e FROM jsonb_array_elements_text(p_content -> 'commissionOptions') e
                  ORDER BY array_position(ARRAY['percentage', 'fixed', 'contract'], e)),
            (p_content ->> 'commissionMaxBasisPoints')::integer, (p_content ->> 'commissionSettlementMaxDays')::integer,
            (p_content ->> 'freightDueDays')::integer, btrim(p_content ->> 'note'),
            CASE WHEN jsonb_typeof(p_content -> 'effectiveFrom') = 'string'
                 THEN (p_content ->> 'effectiveFrom')::timestamptz END,
            p_key, hash, entered.staff_id, entered.at)
    RETURNING * INTO v;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v FROM trucker.financial_setting_version x WHERE x.draft_key = p_key;
    status := CASE WHEN v.drafted_by = entered.staff_id AND v.draft_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.financial_setting_values(v, entered.at) END;
    RETURN;
  END;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.financial_setting.drafted', 'done', NULL, p_request_id,
                              jsonb_build_object('versionId', v.id, 'versionNo', v.version_no));
  status := 'drafted';
  detail := trucker.financial_setting_values(v, entered.at);
END
$$;

-- One move on a version: approve, discard or withdraw. The version is locked, then the
-- settings lock is taken (approve and withdraw), then the clock is read.
--   status: approved | discarded | withdrawn | repeated | same_person | effective_passed
--           | already_effective | not_open | conflict | invalid | not_found | unauthorized | forbidden
CREATE FUNCTION trucker.staff_financial_move(
  p_token_hash text, p_version uuid, p_expected_version integer, p_move text, p_request_id text,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  v trucker.financial_setting_version;
  v_at timestamptz;
  v_action text;
BEGIN
  IF p_move IS NULL OR p_move NOT IN ('approve', 'discard', 'withdraw') THEN
    status := 'invalid';
    RETURN;
  END IF;
  v_action := 'staff.financial_setting.' || p_move;
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, 'staff_admin', v_action, NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO v FROM trucker.financial_setting_version x
  WHERE x.id = p_version AND NOT x.development_default FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_move <> 'discard' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('financial.settings', 0));
  END IF;
  v_at := trucker.clock_now();
  -- The same move already made answers with what it made.
  IF (p_move = 'approve' AND v.status IN ('approved', 'withdrawn') AND v.approved_by = entered.staff_id)
     OR (p_move = 'discard' AND v.status = 'discarded' AND v.closed_by = entered.staff_id)
     OR (p_move = 'withdraw' AND v.status = 'withdrawn' AND v.closed_by = entered.staff_id) THEN
    status := 'repeated';
    detail := trucker.financial_setting_values(v, v_at);
    RETURN;
  END IF;
  IF (p_move IN ('approve', 'discard') AND v.status <> 'draft') OR (p_move = 'withdraw' AND v.status <> 'approved') THEN
    status := 'not_open';
    detail := trucker.financial_setting_values(v, v_at);
    RETURN;
  END IF;
  IF v.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF p_move = 'approve' THEN
    IF v.drafted_by = entered.staff_id THEN
      PERFORM trucker.staff_audit(v_at, entered.staff_id, v_action, 'refused', NULL, p_request_id,
                                  jsonb_build_object('reason', 'same_person', 'versionId', v.id));
      status := 'same_person';
      RETURN;
    END IF;
    IF v.effective_from IS NOT NULL AND v.effective_from <= v_at THEN
      status := 'effective_passed';
      RETURN;
    END IF;
    UPDATE trucker.financial_setting_version x
    SET status = 'approved', approved_by = entered.staff_id, approved_at = v_at,
        effective_at = coalesce(v.effective_from, v_at), row_version = x.row_version + 1
    WHERE x.id = v.id RETURNING * INTO v;
  ELSIF p_move = 'discard' THEN
    UPDATE trucker.financial_setting_version x
    SET status = 'discarded', closed_by = entered.staff_id, closed_at = v_at, row_version = x.row_version + 1
    WHERE x.id = v.id RETURNING * INTO v;
  ELSE
    IF v.effective_at <= v_at THEN
      status := 'already_effective';
      detail := trucker.financial_setting_values(v, v_at);
      RETURN;
    END IF;
    UPDATE trucker.financial_setting_version x
    SET status = 'withdrawn', closed_by = entered.staff_id, closed_at = v_at, row_version = x.row_version + 1
    WHERE x.id = v.id RETURNING * INTO v;
  END IF;
  PERFORM trucker.staff_audit(v_at, entered.staff_id, v_action, 'done', NULL, p_request_id,
                              jsonb_build_object('versionId', v.id, 'versionNo', v.version_no, 'effectiveAt', v.effective_at));
  status := CASE p_move WHEN 'approve' THEN 'approved' WHEN 'discard' THEN 'discarded' ELSE 'withdrawn' END;
  detail := trucker.financial_setting_values(v, v_at);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Bookings: the fee and the freight due days from the version in force at acceptance; the
-- booking records which version that was.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.acceptance_terms(
  p_amount numeric, p_minor_units integer, d trucker.shipment_draft, p_at timestamptz,
  OUT fee_payer text, OUT fee_basis_points integer, OUT fee_amount numeric, OUT payment_due_days integer,
  OUT assignment_hours integer, OUT assignment_lead_hours integer, OUT assignment_due_at timestamptz,
  OUT positioning_minutes integer, OUT completion_minutes integer,
  OUT planned_start_at timestamptz, OUT planned_end_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  f trucker.financial_setting_version;
  g trucker.security_setting;
BEGIN
  -- Shared with every other booking; an approval or a withdrawal waits, and is waited for.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('financial.settings', 0));
  f := trucker.financial_settings_at(p_at);
  SELECT * INTO g FROM trucker.security_setting;
  fee_payer := g.booking_fee_payer;
  fee_basis_points := f.fee_basis_points;
  -- numeric rounding is half away from zero, which for a positive amount is half-up.
  fee_amount := round(p_amount * f.fee_basis_points / 10000, p_minor_units);
  payment_due_days := f.freight_due_days;
  assignment_hours := g.booking_assignment_hours;
  assignment_lead_hours := g.booking_assignment_lead_hours;
  assignment_due_at := least(p_at + make_interval(hours => g.booking_assignment_hours),
                             d.pickup_from_at - make_interval(hours => g.booking_assignment_lead_hours));
  positioning_minutes := g.reservation_positioning_minutes;
  completion_minutes := g.reservation_completion_minutes;
  planned_start_at := d.pickup_from_at - make_interval(mins => g.reservation_positioning_minutes);
  planned_end_at := d.delivery_until_at + make_interval(mins => g.reservation_completion_minutes);
END
$$;

ALTER TABLE trucker.security_setting
  DROP COLUMN booking_fee_basis_points,
  DROP COLUMN booking_payment_due_days;

-- Bookings made before this migration were made under the security settings, not a version.
ALTER TABLE trucker.booking ADD COLUMN financial_setting_version_id uuid REFERENCES trucker.financial_setting_version (id);

CREATE FUNCTION trucker.booking_financial_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  f trucker.financial_setting_version;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('financial.settings', 0));
  f := trucker.financial_settings_at(NEW.accepted_at);
  IF f.id IS NULL OR NEW.fee_basis_points <> f.fee_basis_points OR NEW.payment_due_days <> f.freight_due_days THEN
    RAISE EXCEPTION 'a booking is made under the financial settings in force at its acceptance'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.financial_setting_version_id := f.id;
  RETURN NEW;
END
$$;
CREATE TRIGGER booking_financial_version BEFORE INSERT ON trucker.booking
  FOR EACH ROW EXECUTE FUNCTION trucker.booking_financial_version();

-- ---------------------------------------------------------------------------------------------
-- Commissions: the options and limits of the version in force.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.shipment_commission
  DROP CONSTRAINT shipment_commission_basis_points_check,
  ADD CONSTRAINT shipment_commission_basis_points_check CHECK (basis_points BETWEEN 1 AND 5000);
ALTER TABLE trucker.commission_contract
  DROP CONSTRAINT commission_contract_basis_points_check,
  ADD CONSTRAINT commission_contract_basis_points_check CHECK (basis_points BETWEEN 1 AND 5000),
  DROP CONSTRAINT commission_contract_settlement_days_check,
  ADD CONSTRAINT commission_contract_settlement_days_check CHECK (settlement_days BETWEEN 1 AND 365);

CREATE OR REPLACE FUNCTION trucker.set_shipment_commission(p_shipment uuid, p_expected_version integer, p_content jsonb, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.shipment_draft;
  c trucker.shipment_commission;
  v_option text := p_content ->> 'option';
  v_points integer;
  v_amount numeric;
  v_minor integer;
  problems jsonb := '[]'::jsonb;
  f trucker.financial_setting_version;
BEGIN
  SELECT * INTO entered FROM trucker.shipment_enter(p_shipment);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  d := entered.row_found;
  IF d.status <> 'draft' OR d.published_version IS NOT NULL THEN
    status := 'not_draft';
    RETURN;
  END IF;
  IF d.version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  f := trucker.financial_settings_at(entered.at);
  IF v_option IS NULL OR v_option NOT IN ('none', 'percentage', 'fixed', 'contract') THEN
    problems := problems || jsonb_build_object('field', 'commission', 'code', 'required');
  ELSIF v_option <> 'none' AND NOT (v_option = ANY (f.commission_options)) THEN
    -- An option the settings in force do not offer now.
    problems := problems || jsonb_build_object('field', 'commission', 'code', 'not_offered');
  ELSIF v_option <> 'none' AND trucker.shipment_customer(d.id) = entered.org THEN
    -- A commission is the organiser's, on a shipment it arranges for a customer.
    problems := problems || jsonb_build_object('field', 'commission', 'code', 'own_shipment');
  ELSIF v_option = 'percentage' THEN
    IF coalesce(p_content ->> 'basisPoints', '') !~ '^[0-9]{1,4}$'
       OR (p_content ->> 'basisPoints')::integer NOT BETWEEN 1 AND f.commission_max_basis_points THEN
      problems := problems || jsonb_build_object('field', 'commissionPercentage', 'code', 'out_of_range');
    ELSE
      v_points := (p_content ->> 'basisPoints')::integer;
    END IF;
  ELSIF v_option = 'fixed' THEN
    SELECT x.minor_units INTO v_minor FROM trucker.currency x WHERE x.code = p_content ->> 'currency';
    IF v_minor IS NULL THEN
      problems := problems || jsonb_build_object('field', 'commissionCurrency', 'code', 'unavailable');
    ELSIF coalesce(p_content ->> 'amount', '') !~ ('^[0-9]{1,12}(\.[0-9]{1,' || greatest(v_minor, 1) || '})?$')
          OR (v_minor = 0 AND p_content ->> 'amount' ~ '\.')
          OR (p_content ->> 'amount')::numeric <= 0 THEN
      problems := problems || jsonb_build_object('field', 'commissionAmount', 'code', 'invalid');
    ELSE
      v_amount := (p_content ->> 'amount')::numeric;
    END IF;
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  DELETE FROM trucker.shipment_commission x WHERE x.shipment_id = d.id;
  IF v_option <> 'none' THEN
    INSERT INTO trucker.shipment_commission
      (shipment_id, option, basis_points, fixed_amount, currency_code, set_by, set_at)
    VALUES (d.id, v_option, v_points, v_amount,
            CASE WHEN v_option = 'fixed' THEN p_content ->> 'currency' END, entered.actor, entered.at)
    RETURNING * INTO c;
  END IF;
  PERFORM trucker.fleet_audit(entered.at, entered.actor, NULL, entered.org, 'shipment.commission_set',
                              'shipment_draft', d.id, NULL,
                              coalesce(trucker.shipment_commission_values(c), jsonb_build_object('option', 'none')));
  status := 'saved';
  detail := trucker.shipment_commission_values(c);
END
$function$;

CREATE OR REPLACE FUNCTION trucker.contract_problems(p_content jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
DECLARE
  v_option text := p_content ->> 'option';
  v_minor integer;
  problems jsonb := '[]'::jsonb;
  f trucker.financial_setting_version := trucker.financial_settings_at(trucker.clock_now());
BEGIN
  IF v_option IS NULL OR v_option NOT IN ('percentage', 'fixed') THEN
    problems := problems || jsonb_build_object('field', 'option', 'code', 'required');
  ELSIF v_option = 'percentage' THEN
    IF coalesce(p_content ->> 'basisPoints', '') !~ '^[0-9]{1,4}$'
       OR (p_content ->> 'basisPoints')::integer NOT BETWEEN 1 AND f.commission_max_basis_points THEN
      problems := problems || jsonb_build_object('field', 'basisPoints', 'code', 'out_of_range');
    END IF;
  ELSE
    SELECT x.minor_units INTO v_minor FROM trucker.currency x WHERE x.code = p_content ->> 'currency';
    IF v_minor IS NULL THEN
      problems := problems || jsonb_build_object('field', 'currency', 'code', 'unavailable');
    ELSIF coalesce(p_content ->> 'amount', '') !~ ('^[0-9]{1,12}(\.[0-9]{1,' || greatest(v_minor, 1) || '})?$')
          OR (v_minor = 0 AND p_content ->> 'amount' ~ '\.')
          OR (p_content ->> 'amount')::numeric <= 0 THEN
      problems := problems || jsonb_build_object('field', 'amount', 'code', 'invalid');
    END IF;
  END IF;
  IF coalesce(p_content ->> 'settlementDays', '') !~ '^[0-9]{1,2}$'
     OR (p_content ->> 'settlementDays')::integer NOT BETWEEN 1 AND f.commission_settlement_max_days THEN
    problems := problems || jsonb_build_object('field', 'settlementDays', 'code', 'out_of_range');
  END IF;
  RETURN problems;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.shipment_commission_terms(p_shipment uuid, p_amount text, p_currency text, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  d trucker.shipment_draft;
  c trucker.shipment_commission;
  f record;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment;
  -- The keeper of the shipment, or a carrier while it is published. Never the customer.
  IF NOT FOUND OR NOT (d.organisation_id = v_org
                       OR (d.status = 'published' AND trucker.is_carrier(v_org)
                           AND trucker.shipment_customer(d.id) <> v_org)) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO c FROM trucker.shipment_commission x WHERE x.shipment_id = d.id;
  status := 'ok';
  detail := jsonb_build_object('commission', trucker.shipment_commission_values(c));
  -- Under the contract option, a carrier is told the contract it holds with the organiser.
  IF c.option = 'contract' AND d.organisation_id <> v_org THEN
    detail := detail || jsonb_build_object('contract', (
      SELECT trucker.contract_values(k, v_org) FROM trucker.commission_contract k
      WHERE k.organiser_organisation_id = trucker.shipment_organiser(d.id)
        AND k.carrier_organisation_id = v_org AND k.status = 'active'));
  END IF;
  IF d.organisation_id = v_org THEN
    detail := detail || jsonb_build_object(
      'arranged', trucker.shipment_customer(d.id) <> v_org,
      'editable', d.status = 'draft' AND d.published_version IS NULL,
      -- What the settings in force allow, for the organiser's form.
      'limits', (SELECT jsonb_build_object('options', to_jsonb(f.commission_options),
                                           'maxBasisPoints', f.commission_max_basis_points)
                 FROM trucker.financial_settings_at(trucker.clock_now()) f));
  END IF;
  IF c.shipment_id IS NOT NULL AND p_amount ~ '^[0-9]{1,12}(\.[0-9]{1,3})?$'
     AND EXISTS (SELECT 1 FROM trucker.currency x WHERE x.code = p_currency) THEN
    SELECT * INTO f FROM trucker.commission_figures_for(
      d.id, CASE WHEN d.organisation_id <> v_org THEN v_org END, p_amount::numeric, p_currency);
    detail := detail || jsonb_build_object('figures', jsonb_build_object(
      'state', f.status,
      'commission', CASE WHEN f.status = 'ok' THEN trucker.amount_text(f.commission, f.minor) END,
      'net', CASE WHEN f.status = 'ok' THEN trucker.amount_text(f.net, f.minor) END,
      'currency', p_currency));
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.commission_contracts(OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  entered record;
BEGIN
  SELECT * INTO entered FROM trucker.authority_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  detail := jsonb_build_object(
    'accountCode', (SELECT o.account_code FROM trucker.organisation o WHERE o.id = entered.org),
    'organiser', trucker.capability_effective(entered.org, 'organise'),
    'carrier', trucker.is_carrier(entered.org),
    'limits', (SELECT jsonb_build_object('maxBasisPoints', f.commission_max_basis_points,
                                         'settlementMaxDays', f.commission_settlement_max_days)
               FROM trucker.financial_settings_at(trucker.clock_now()) f),
    'contracts', coalesce((
      SELECT jsonb_agg(trucker.contract_values(k, entered.org) ORDER BY k.proposed_at DESC, k.id)
      FROM trucker.commission_contract k
      WHERE entered.org IN (k.organiser_organisation_id, k.carrier_organisation_id)), '[]'::jsonb));
END
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.financial_settings_ready(),
  trucker.staff_financial_settings(text, text),
  trucker.staff_financial_draft(text, text, jsonb, text),
  trucker.staff_financial_move(text, uuid, integer, text, text)
TO trucker_app;
