-- 0031: undeliverable and refused cargo (R-406), slice 18d.
--
-- Decided by Abdullah on 18 November 2026 (11:23). Three things are recorded separately and never
-- assumed to be one party: who may instruct what happens to the cargo, who approves or funds a cost
-- for now, and who finally bears it under the contract, a settlement or a competent decision. Paying
-- Trucker's fee or the freight gives no right to direct the cargo; approving an action proves no
-- liability for its cause. Trucker records, coordinates and mediates; it never decides liability
-- alone, and nothing here moves money.
--
-- The contracting customer declares at the booking that it holds the authority to instruct, on what
-- basis, with a spending limit and an alternate contact; it may give the organiser an explicit
-- mandate for named actions. The receiver can refuse and give a reason, and gains no authority.
-- Authority is checked again at every instruction; an ended or expired one allows nothing new.
--
-- When delivery fails, the driver (or someone on the driver's behalf, shown as such) records why,
-- where, the cargo's condition and the quantities delivered and remaining. A case opens; nothing is
-- recorded as delivered or cancelled by it. The authorised party chooses an action (retry, another
-- destination, temporary storage, return); the carrier answers with feasibility, time and itemised
-- costs; the authorised party approves within its limit before anything is done. Silence approves
-- nothing. When nobody answers by the response time, which depends on the cargo's class, the case is
-- escalated, and the carrier may take only a protective action named in the emergency plan of the
-- booking's terms, within its cap. Selling, destroying, abandoning or moving cargo across a border is
-- never an action here. Instructions of a competent authority are recorded and limit what may be
-- instructed.
--
-- Cargo leaves the vehicle by a handover that the receiving side confirms; without confirmation the
-- custody has not moved. A resource is released only when nothing remains on it and no leg it drives
-- is under way; waiting stops at release while storage may continue. A retry, a new destination or a
-- return driven by the same truck is a leg of the original trip: the occupancy continues and the
-- booking and trip are never rewritten. A disputed cost or a claim of carrier fault places a hold
-- owned by that cause, on those costs only; only its owner's recorded decision releases it.
--
-- Development defaults, not approved for production: UD-1 to UD-10 (UNDELIVERABLE_SLICE_18D.md).

-- ---------------------------------------------------------------------------------------------
-- The booking's terms: exception settings are part of the financial setting versions (section 10)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.financial_setting_version
  ADD COLUMN response_minutes_general integer NOT NULL DEFAULT 240 CHECK (response_minutes_general BETWEEN 5 AND 10080),
  ADD COLUMN response_minutes_temperature integer NOT NULL DEFAULT 60 CHECK (response_minutes_temperature BETWEEN 5 AND 10080),
  ADD COLUMN response_minutes_dangerous integer NOT NULL DEFAULT 30 CHECK (response_minutes_dangerous BETWEEN 5 AND 10080),
  ADD COLUMN escalation_minutes integer NOT NULL DEFAULT 60 CHECK (escalation_minutes BETWEEN 5 AND 10080),
  ADD COLUMN free_waiting_minutes integer NOT NULL DEFAULT 120 CHECK (free_waiting_minutes BETWEEN 0 AND 10080),
  ADD COLUMN exception_rate_currency text NOT NULL DEFAULT 'XTS' CHECK (exception_rate_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN waiting_rate_per_hour numeric NOT NULL DEFAULT 10 CHECK (waiting_rate_per_hour >= 0),
  ADD COLUMN storage_rate_per_day numeric NOT NULL DEFAULT 25 CHECK (storage_rate_per_day >= 0),
  ADD COLUMN emergency_actions text[] NOT NULL DEFAULT ARRAY['temporary_storage'],
  ADD COLUMN emergency_cap numeric NOT NULL DEFAULT 100 CHECK (emergency_cap >= 0),
  ADD COLUMN return_trip_fee text NOT NULL DEFAULT 'none' CHECK (return_trip_fee IN ('none', 'carrier_offer'));
ALTER TABLE trucker.financial_setting_version ADD CONSTRAINT financial_setting_emergency_actions CHECK (
  emergency_actions <@ ARRAY['temporary_storage', 'retry_delivery', 'return_to_sender']);

CREATE OR REPLACE FUNCTION trucker.guard_financial_setting()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
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
      NEW.freight_due_days, NEW.fee_payment_hours, NEW.note, NEW.effective_from, NEW.draft_key, NEW.draft_hash, NEW.drafted_by,
      NEW.drafted_at, NEW.response_minutes_general, NEW.response_minutes_temperature, NEW.response_minutes_dangerous, NEW.escalation_minutes, NEW.free_waiting_minutes, NEW.exception_rate_currency, NEW.waiting_rate_per_hour, NEW.storage_rate_per_day, NEW.emergency_actions, NEW.emergency_cap, NEW.return_trip_fee)
     IS DISTINCT FROM
     (OLD.id, OLD.version_no, OLD.development_default, OLD.fee_method, OLD.fee_basis_points, OLD.fee_rounding,
      OLD.commission_options, OLD.commission_max_basis_points, OLD.commission_settlement_max_days,
      OLD.freight_due_days, OLD.fee_payment_hours, OLD.note, OLD.effective_from, OLD.draft_key, OLD.draft_hash, OLD.drafted_by,
      OLD.drafted_at, OLD.response_minutes_general, OLD.response_minutes_temperature, OLD.response_minutes_dangerous, OLD.escalation_minutes, OLD.free_waiting_minutes, OLD.exception_rate_currency, OLD.waiting_rate_per_hour, OLD.storage_rate_per_day, OLD.emergency_actions, OLD.emergency_cap, OLD.return_trip_fee)
     OR NOT ((OLD.status = 'draft' AND NEW.status IN ('approved', 'discarded'))
             OR (OLD.status = 'approved' AND NEW.status = 'withdrawn'
                 AND NEW.effective_at = OLD.effective_at AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by
                 AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at
                 AND trucker.clock_now() < OLD.effective_at)) THEN
    RAISE EXCEPTION 'a financial setting version is never changed or removed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.financial_setting_problems(p_content jsonb, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
DECLARE
  problems jsonb := '[]'::jsonb;
  field text;
  bounds integer[];
  v_from timestamptz;
BEGIN
  FOR field, bounds IN
    SELECT * FROM (VALUES ('feeBasisPoints', ARRAY[0, 5000]), ('commissionMaxBasisPoints', ARRAY[1, 5000]),
                          ('commissionSettlementMaxDays', ARRAY[1, 365]), ('freightDueDays', ARRAY[0, 365]),
                          ('feePaymentHours', ARRAY[1, 168])) f
  LOOP
    IF jsonb_typeof(p_content -> field) IS DISTINCT FROM 'number'
       OR (p_content ->> field) !~ '^[0-9]{1,4}$'
       OR (p_content ->> field)::integer NOT BETWEEN bounds[1] AND bounds[2] THEN
      problems := problems || jsonb_build_object('field', field, 'code', 'out_of_range');
    END IF;
  END LOOP;
  -- Exception settings (R-406, section 10): optional; a draft without them keeps the values in force.
  FOR field, bounds IN
    SELECT * FROM (VALUES ('responseMinutesGeneral', ARRAY[5, 10080]), ('responseMinutesTemperature', ARRAY[5, 10080]),
                          ('responseMinutesDangerous', ARRAY[5, 10080]), ('escalationMinutes', ARRAY[5, 10080]),
                          ('freeWaitingMinutes', ARRAY[0, 10080])) f
  LOOP
    IF p_content ? field AND (jsonb_typeof(p_content -> field) IS DISTINCT FROM 'number'
       OR (p_content ->> field) !~ '^[0-9]{1,5}$' OR (p_content ->> field)::integer NOT BETWEEN bounds[1] AND bounds[2]) THEN
      problems := problems || jsonb_build_object('field', field, 'code', 'out_of_range');
    END IF;
  END LOOP;
  FOR field IN SELECT unnest(ARRAY['waitingRatePerHour', 'storageRatePerDay', 'emergencyCap']) LOOP
    IF p_content ? field AND (jsonb_typeof(p_content -> field) IS DISTINCT FROM 'string'
       OR (p_content ->> field) !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$') THEN
      problems := problems || jsonb_build_object('field', field, 'code', 'invalid');
    END IF;
  END LOOP;
  IF p_content ? 'exceptionRateCurrency' AND coalesce(p_content ->> 'exceptionRateCurrency', '') !~ '^[A-Z]{3}$' THEN
    problems := problems || jsonb_build_object('field', 'exceptionRateCurrency', 'code', 'invalid');
  END IF;
  IF p_content ? 'emergencyActions' AND (jsonb_typeof(p_content -> 'emergencyActions') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_content -> 'emergencyActions') e
                WHERE jsonb_typeof(e) <> 'string'
                   OR e #>> '{}' NOT IN ('temporary_storage', 'retry_delivery', 'return_to_sender'))) THEN
    problems := problems || jsonb_build_object('field', 'emergencyActions', 'code', 'invalid');
  END IF;
  IF p_content ? 'returnTripFee' AND coalesce(p_content ->> 'returnTripFee', '') NOT IN ('none', 'carrier_offer') THEN
    problems := problems || jsonb_build_object('field', 'returnTripFee', 'code', 'invalid');
  END IF;
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
$function$;

CREATE OR REPLACE FUNCTION trucker.staff_financial_draft(p_token_hash text, p_key text, p_content jsonb, p_request_id text, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  entered record;
  v trucker.financial_setting_version;
  hash text := trucker.content_hash(coalesce(p_content, '{}'::jsonb));
  problems jsonb;
  cur trucker.financial_setting_version;
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
  cur := trucker.financial_settings_at(entered.at);
  BEGIN
    INSERT INTO trucker.financial_setting_version
      (status, fee_basis_points, commission_options, commission_max_basis_points, commission_settlement_max_days,
       freight_due_days, fee_payment_hours, note, effective_from, draft_key, draft_hash, drafted_by, drafted_at,
       response_minutes_general, response_minutes_temperature, response_minutes_dangerous, escalation_minutes,
       free_waiting_minutes, exception_rate_currency, waiting_rate_per_hour, storage_rate_per_day, emergency_actions,
       emergency_cap, return_trip_fee)
    VALUES ('draft', (p_content ->> 'feeBasisPoints')::integer,
            ARRAY(SELECT e FROM jsonb_array_elements_text(p_content -> 'commissionOptions') e
                  ORDER BY array_position(ARRAY['percentage', 'fixed', 'contract'], e)),
            (p_content ->> 'commissionMaxBasisPoints')::integer, (p_content ->> 'commissionSettlementMaxDays')::integer,
            (p_content ->> 'freightDueDays')::integer, (p_content ->> 'feePaymentHours')::integer,
            btrim(p_content ->> 'note'),
            CASE WHEN jsonb_typeof(p_content -> 'effectiveFrom') = 'string'
                 THEN (p_content ->> 'effectiveFrom')::timestamptz END,
            p_key, hash, entered.staff_id, entered.at,
            -- Exception settings not given keep the values in force (R-406, section 10).
            coalesce((p_content ->> 'responseMinutesGeneral')::integer, cur.response_minutes_general),
            coalesce((p_content ->> 'responseMinutesTemperature')::integer, cur.response_minutes_temperature),
            coalesce((p_content ->> 'responseMinutesDangerous')::integer, cur.response_minutes_dangerous),
            coalesce((p_content ->> 'escalationMinutes')::integer, cur.escalation_minutes),
            coalesce((p_content ->> 'freeWaitingMinutes')::integer, cur.free_waiting_minutes),
            coalesce(p_content ->> 'exceptionRateCurrency', cur.exception_rate_currency),
            coalesce((p_content ->> 'waitingRatePerHour')::numeric, cur.waiting_rate_per_hour),
            coalesce((p_content ->> 'storageRatePerDay')::numeric, cur.storage_rate_per_day),
            CASE WHEN p_content ? 'emergencyActions'
                 THEN ARRAY(SELECT e FROM jsonb_array_elements_text(p_content -> 'emergencyActions') e ORDER BY e)
                 ELSE cur.emergency_actions END,
            coalesce((p_content ->> 'emergencyCap')::numeric, cur.emergency_cap),
            coalesce(p_content ->> 'returnTripFee', cur.return_trip_fee))
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
$function$;

CREATE OR REPLACE FUNCTION trucker.financial_setting_values(v trucker.financial_setting_version, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
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
    'feePaymentHours', v.fee_payment_hours,
    'responseMinutesGeneral', v.response_minutes_general, 'responseMinutesTemperature', v.response_minutes_temperature,
    'responseMinutesDangerous', v.response_minutes_dangerous, 'escalationMinutes', v.escalation_minutes,
    'freeWaitingMinutes', v.free_waiting_minutes, 'exceptionRateCurrency', v.exception_rate_currency,
    'waitingRatePerHour', v.waiting_rate_per_hour, 'storageRatePerDay', v.storage_rate_per_day,
    'emergencyActions', to_jsonb(v.emergency_actions), 'emergencyCap', v.emergency_cap, 'returnTripFee', v.return_trip_fee,
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
$function$;

-- Which response time applies (section 6): a dangerous load, a temperature-controlled one, or other.
ALTER TABLE trucker.equipment_type ADD COLUMN temperature_controlled boolean NOT NULL DEFAULT false;

CREATE FUNCTION trucker.booking_cargo_class(b trucker.booking) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE
    WHEN coalesce((b.shipment_snapshot ->> 'dangerousGoods')::boolean, false) THEN 'dangerous'
    WHEN EXISTS (SELECT 1 FROM trucker.equipment_type e
                 WHERE e.code = b.shipment_snapshot #>> '{equipment,type}' AND e.temperature_controlled) THEN 'temperature'
    ELSE 'general' END
$$;

-- The terms of a booking: the financial setting version it recorded at acceptance, or the version in
-- force then. A later version never changes an earlier booking.
CREATE FUNCTION trucker.booking_terms_version(b trucker.booking) RETURNS trucker.financial_setting_version
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce((SELECT v FROM trucker.financial_setting_version v WHERE v.id = b.financial_setting_version_id),
                  trucker.financial_settings_at(b.accepted_at))
$$;

CREATE FUNCTION trucker.instruction_actions() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['retry_delivery', 'alternate_destination', 'temporary_storage', 'return_to_sender', 'return_destination']
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may instruct (section 3)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.instruction_authority (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  holder_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  -- The contracting customer declaring its own authority, or the organiser holding its mandate.
  holder_role text NOT NULL CHECK (holder_role IN ('contracting_customer', 'organiser')),
  basis text NOT NULL CHECK (basis IN ('customer_declared_contract', 'customer_mandate')),
  basis_note text NOT NULL CHECK (char_length(basis_note) BETWEEN 1 AND 1000),
  actions text[] NOT NULL CHECK (cardinality(actions) >= 1 AND actions <@ trucker.instruction_actions()),
  spend_limit numeric NOT NULL CHECK (spend_limit >= 0),
  currency_code text NOT NULL,
  valid_until timestamptz,
  alternate_contact text NOT NULL CHECK (char_length(alternate_contact) BETWEEN 1 AND 300),
  declared_by uuid NOT NULL REFERENCES trucker.person (id),
  declared_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_by uuid REFERENCES trucker.person (id),
  end_reason text CHECK (end_reason IS NULL OR char_length(end_reason) BETWEEN 1 AND 1000),
  CONSTRAINT instruction_authority_basis CHECK (
    (holder_role = 'contracting_customer') = (basis = 'customer_declared_contract')),
  CONSTRAINT instruction_authority_ended CHECK (
    (ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL))
);
-- One authority in force for each holder of a booking; earlier ones stay as history.
CREATE UNIQUE INDEX instruction_authority_one_active ON trucker.instruction_authority (booking_id, holder_organisation_id)
  WHERE ended_at IS NULL;

CREATE FUNCTION trucker.guard_instruction_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id, NEW.booking_id, NEW.holder_organisation_id, NEW.holder_role, NEW.basis, NEW.basis_note, NEW.actions,
          NEW.spend_limit, NEW.currency_code, NEW.valid_until, NEW.alternate_contact, NEW.declared_by, NEW.declared_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.booking_id, OLD.holder_organisation_id, OLD.holder_role, OLD.basis, OLD.basis_note, OLD.actions,
          OLD.spend_limit, OLD.currency_code, OLD.valid_until, OLD.alternate_contact, OLD.declared_by, OLD.declared_at)
     AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an instruction authority is only ever ended, once' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER instruction_authority_guard BEFORE UPDATE OR DELETE ON trucker.instruction_authority
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_instruction_authority();
CREATE TRIGGER instruction_authority_truncate_guard BEFORE TRUNCATE ON trucker.instruction_authority
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

-- The authority an organisation holds on a booking at a moment, if any.
CREATE FUNCTION trucker.instruction_authority_of(p_booking uuid, p_org uuid, p_at timestamptz)
RETURNS trucker.instruction_authority
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT a.* FROM trucker.instruction_authority a
  WHERE a.booking_id = p_booking AND a.holder_organisation_id = p_org AND a.ended_at IS NULL
    AND (a.valid_until IS NULL OR a.valid_until > p_at)
  LIMIT 1
$$;

-- ---------------------------------------------------------------------------------------------
-- What failed at delivery (section 4)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.shortfall_reasons() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['wrong_address', 'receiver_absent', 'site_not_ready', 'site_closed', 'receiver_refused',
               'cargo_damaged', 'document_problem', 'carrier_delay', 'other']
$$;

CREATE TABLE trucker.delivery_shortfall (
  outcome_id uuid PRIMARY KEY REFERENCES trucker.trip_delivery_outcome (id),
  reason text NOT NULL CHECK (reason = ANY (trucker.shortfall_reasons())),
  -- What the receiver said, if they refused. Recording it gives the receiver no authority.
  refusal_reason text CHECK (refusal_reason IS NULL OR char_length(refusal_reason) BETWEEN 1 AND 1000),
  location text NOT NULL CHECK (char_length(location) BETWEEN 1 AND 500),
  cargo_condition text NOT NULL CHECK (char_length(cargo_condition) BETWEEN 1 AND 1000),
  quantity_unit text NOT NULL CHECK (char_length(quantity_unit) BETWEEN 1 AND 40),
  quantity_delivered numeric NOT NULL CHECK (quantity_delivered >= 0),
  quantity_remaining numeric NOT NULL CHECK (quantity_remaining > 0),
  contact_attempts integer NOT NULL CHECK (contact_attempts BETWEEN 0 AND 100),
  contact_note text CHECK (contact_note IS NULL OR char_length(contact_note) BETWEEN 1 AND 1000),
  evidence_note text CHECK (evidence_note IS NULL OR char_length(evidence_note) BETWEEN 1 AND 1000)
);
CREATE TRIGGER delivery_shortfall_guard BEFORE UPDATE OR DELETE ON trucker.delivery_shortfall
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER delivery_shortfall_truncate_guard BEFORE TRUNCATE ON trucker.delivery_shortfall
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

-- ---------------------------------------------------------------------------------------------
-- The case, instructions and their execution (section 4); legs of the trip (section 8)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.cargo_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  trip_id uuid NOT NULL UNIQUE REFERENCES trucker.trip (id),
  cargo_class text NOT NULL CHECK (cargo_class IN ('general', 'temperature', 'dangerous')),
  opened_at timestamptz NOT NULL,
  response_due_at timestamptz NOT NULL,
  escalate_at timestamptz NOT NULL,
  escalated_at timestamptz,
  -- A competent authority's instruction, recorded by operations; it limits what may be instructed.
  authority_order text CHECK (authority_order IS NULL OR char_length(authority_order) BETWEEN 1 AND 2000),
  authority_allowed_actions text[] CHECK (authority_allowed_actions IS NULL OR authority_allowed_actions <@ trucker.instruction_actions()),
  closed_at timestamptz,
  closed_by uuid REFERENCES trucker.staff_account (id),
  close_note text CHECK (close_note IS NULL OR char_length(close_note) BETWEEN 1 AND 1000),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT cargo_case_closed CHECK ((closed_at IS NULL) = (closed_by IS NULL) AND (closed_at IS NULL) = (close_note IS NULL)),
  CONSTRAINT cargo_case_times CHECK (response_due_at > opened_at AND escalate_at > response_due_at)
);

CREATE TABLE trucker.cargo_instruction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES trucker.cargo_case (id),
  action text NOT NULL CHECK (action = ANY (trucker.instruction_actions())),
  destination text CHECK (destination IS NULL OR char_length(destination) BETWEEN 1 AND 500),
  details text CHECK (details IS NULL OR char_length(details) BETWEEN 1 AND 2000),
  -- Who instructed, under which authority; or the carrier under the emergency plan.
  issued_by uuid NOT NULL REFERENCES trucker.person (id),
  issuer_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  authority_id uuid REFERENCES trucker.instruction_authority (id),
  emergency boolean NOT NULL DEFAULT false,
  issued_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('requested', 'offered', 'approved', 'executing', 'completed', 'failed',
                                       'declined', 'not_feasible', 'withdrawn')),
  -- The carrier's answer.
  feasible boolean,
  offer_eta timestamptz,
  offer_note text CHECK (offer_note IS NULL OR char_length(offer_note) BETWEEN 1 AND 2000),
  offered_by uuid REFERENCES trucker.person (id),
  offered_at timestamptz,
  -- The approval, by the authorised party, or the emergency plan.
  decided_by uuid REFERENCES trucker.person (id),
  decided_at timestamptz,
  approval_basis text CHECK (approval_basis IS NULL OR approval_basis IN ('authorised_party', 'emergency_plan')),
  approved_total numeric,
  terms_version_id uuid REFERENCES trucker.financial_setting_version (id),
  started_at timestamptz,
  ended_at timestamptz,
  execution_note text CHECK (execution_note IS NULL OR char_length(execution_note) BETWEEN 1 AND 2000),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT cargo_instruction_destination CHECK (
    action IN ('temporary_storage', 'retry_delivery', 'return_to_sender') OR destination IS NOT NULL),
  CONSTRAINT cargo_instruction_authority CHECK (emergency OR authority_id IS NOT NULL),
  CONSTRAINT cargo_instruction_emergency CHECK (NOT emergency OR approval_basis = 'emergency_plan')
);
-- At most one instruction is open on a case: stale or simultaneous ones cannot both run (section 3).
CREATE UNIQUE INDEX cargo_instruction_one_open ON trucker.cargo_instruction (case_id)
  WHERE state IN ('requested', 'offered', 'approved', 'executing');

-- A leg of the original trip, driven by the same resources: the occupancy continues (section 8).
CREATE TABLE trucker.trip_leg (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trucker.trip (id),
  instruction_id uuid NOT NULL UNIQUE REFERENCES trucker.cargo_instruction (id),
  kind text NOT NULL CHECK (kind IN ('retry_delivery', 'alternate_destination', 'return_to_sender', 'return_destination')),
  destination text NOT NULL CHECK (char_length(destination) BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'departed', 'arrived', 'completed')),
  created_at timestamptz NOT NULL,
  departed_at timestamptz,
  arrived_at timestamptz,
  completed_at timestamptz,
  -- Its own delivery record: who received how much.
  quantity_delivered numeric CHECK (quantity_delivered IS NULL OR quantity_delivered >= 0),
  receiver_name text CHECK (receiver_name IS NULL OR char_length(receiver_name) BETWEEN 1 AND 200),
  completion_note text CHECK (completion_note IS NULL OR char_length(completion_note) BETWEEN 1 AND 1000),
  recorded_by uuid REFERENCES trucker.person (id),
  CONSTRAINT trip_leg_completed CHECK ((state = 'completed') = (completed_at IS NOT NULL)
                                       AND (state = 'completed') = (quantity_delivered IS NOT NULL))
);

-- ---------------------------------------------------------------------------------------------
-- Costs (section 5) and holds and claims (section 9)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.exception_cost (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES trucker.cargo_case (id),
  instruction_id uuid NOT NULL REFERENCES trucker.cargo_instruction (id),
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 20),
  UNIQUE (instruction_id, line_no),
  kind text NOT NULL CHECK (kind IN ('waiting', 'handling', 'unloading', 'storage', 'retry', 'alternate_transport',
                                     'return', 'other')),
  description text CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 500),
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit text NOT NULL CHECK (unit IN ('hour', 'day', 'trip', 'item', 'lump_sum')),
  unit_amount numeric NOT NULL CHECK (unit_amount >= 0),
  amount numeric NOT NULL CHECK (amount >= 0),
  currency_code text NOT NULL,
  offered_by uuid NOT NULL REFERENCES trucker.person (id),
  offered_by_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  offered_at timestamptz NOT NULL,
  terms_version_id uuid REFERENCES trucker.financial_setting_version (id),
  -- Three separate facts: who approved it, who funds it for now, who finally bears it.
  interim_payer text NOT NULL DEFAULT 'not_set' CHECK (interim_payer IN ('not_set', 'instructing_party', 'carrier')),
  provisional_liability text NOT NULL CHECK (provisional_liability IN ('per_contract', 'pending')),
  final_liability text CHECK (final_liability IS NULL OR final_liability IN ('contracting_customer', 'organiser',
                                                                             'carrier', 'shared', 'other')),
  final_source text CHECK (final_source IS NULL OR final_source IN ('contract', 'settlement', 'competent_decision')),
  final_reference text CHECK (final_reference IS NULL OR char_length(final_reference) BETWEEN 1 AND 500),
  final_recorded_by uuid REFERENCES trucker.staff_account (id),
  final_recorded_at timestamptz,
  CONSTRAINT exception_cost_final CHECK (
    (final_liability IS NULL) = (final_source IS NULL) AND (final_liability IS NULL) = (final_reference IS NULL)
    AND (final_liability IS NULL) = (final_recorded_by IS NULL) AND (final_liability IS NULL) = (final_recorded_at IS NULL))
);

CREATE TABLE trucker.carrier_claim (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES trucker.cargo_case (id),
  raised_by uuid NOT NULL REFERENCES trucker.person (id),
  raised_by_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  raised_at timestamptz NOT NULL,
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  cost_ids uuid[] NOT NULL CHECK (cardinality(cost_ids) >= 1),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'decided', 'withdrawn')),
  decision text CHECK (decision IS NULL OR decision IN ('upheld', 'partly_upheld', 'rejected')),
  decision_source text CHECK (decision_source IS NULL OR decision_source IN ('contract', 'settlement', 'competent_decision')),
  decision_reference text CHECK (decision_reference IS NULL OR char_length(decision_reference) BETWEEN 1 AND 500),
  decided_by uuid REFERENCES trucker.staff_account (id),
  decided_at timestamptz,
  CONSTRAINT carrier_claim_decided CHECK (
    (state = 'decided') = (decision IS NOT NULL) AND (decision IS NULL) = (decided_at IS NULL)
    AND (decision IS NULL) = (decision_source IS NULL) AND (decision IS NULL) = (decision_reference IS NULL))
);

-- One hold per cause, on named costs only; released only by its owner's recorded decision (DI-401).
CREATE TABLE trucker.settlement_hold (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  owner_kind text NOT NULL CHECK (owner_kind IN ('cost_dispute', 'carrier_claim')),
  owner_id uuid NOT NULL,
  cost_ids uuid[] NOT NULL CHECK (cardinality(cost_ids) >= 1),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  placed_by uuid NOT NULL REFERENCES trucker.person (id),
  placed_at timestamptz NOT NULL,
  released_at timestamptz,
  released_by uuid REFERENCES trucker.staff_account (id),
  release_note text CHECK (release_note IS NULL OR char_length(release_note) BETWEEN 1 AND 1000),
  CONSTRAINT settlement_hold_released CHECK (
    (released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_note IS NULL))
);

-- The receipt of cargo handed over: confirmed or rejected by the receiving side (section 7).
CREATE TABLE trucker.cargo_handover_receipt (
  handover_id uuid PRIMARY KEY REFERENCES trucker.cargo_handover (id),
  state text NOT NULL CHECK (state IN ('confirmed', 'rejected')),
  reference text NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 500),
  confirmed_by uuid REFERENCES trucker.person (id),
  confirmed_by_staff uuid REFERENCES trucker.staff_account (id),
  confirmed_at timestamptz NOT NULL,
  CONSTRAINT cargo_handover_receipt_one CHECK ((confirmed_by IS NULL) <> (confirmed_by_staff IS NULL))
);

-- Handovers record quantity, condition and both sides' standing; several may share one outcome.
ALTER TABLE trucker.cargo_handover DROP CONSTRAINT cargo_handover_outcome_id_key;
ALTER TABLE trucker.cargo_handover DROP CONSTRAINT cargo_handover_kind_check;
ALTER TABLE trucker.cargo_handover
  ADD CONSTRAINT cargo_handover_kind_check CHECK (kind IN ('returned_to_shipper', 'delivered_elsewhere',
    'replacement_vehicle', 'warehouse', 'alternate_carrier', 'consignee')),
  ADD COLUMN quantity numeric CHECK (quantity IS NULL OR quantity > 0),
  ADD COLUMN quantity_unit text CHECK (quantity_unit IS NULL OR char_length(quantity_unit) BETWEEN 1 AND 40),
  ADD COLUMN condition text CHECK (condition IS NULL OR char_length(condition) BETWEEN 1 AND 1000),
  ADD COLUMN evidence_note text CHECK (evidence_note IS NULL OR char_length(evidence_note) BETWEEN 1 AND 1000),
  ADD COLUMN handed_by_standing text CHECK (handed_by_standing IS NULL OR char_length(handed_by_standing) BETWEEN 1 AND 300),
  ADD COLUMN received_by_standing text CHECK (received_by_standing IS NULL OR char_length(received_by_standing) BETWEEN 1 AND 300),
  ADD COLUMN instruction_id uuid REFERENCES trucker.cargo_instruction (id);

-- The idempotent record of every accepted command (section 12, test 3): the same key again returns
-- the first answer and changes nothing.
CREATE TABLE trucker.cargo_command (
  actor_id uuid NOT NULL,
  command_key text NOT NULL,
  command_hash text NOT NULL,
  status text NOT NULL,
  detail jsonb,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, command_key)
);

CREATE FUNCTION trucker.guard_cargo_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'cargo_case' THEN IF
       (NEW.id, NEW.booking_id, NEW.trip_id, NEW.cargo_class, NEW.opened_at, NEW.response_due_at, NEW.escalate_at)
           IS NOT DISTINCT FROM (OLD.id, OLD.booking_id, OLD.trip_id, OLD.cargo_class, OLD.opened_at, OLD.response_due_at, OLD.escalate_at)
       AND (OLD.escalated_at IS NULL OR NEW.escalated_at IS NOT DISTINCT FROM OLD.escalated_at)
       AND (OLD.authority_order IS NULL OR (NEW.authority_order, NEW.authority_allowed_actions)
                                           IS NOT DISTINCT FROM (OLD.authority_order, OLD.authority_allowed_actions))
       AND (OLD.closed_at IS NULL OR (NEW.closed_at, NEW.closed_by, NEW.close_note)
                                     IS NOT DISTINCT FROM (OLD.closed_at, OLD.closed_by, OLD.close_note))
       AND NEW.row_version = OLD.row_version + 1 THEN
      RETURN NEW;
    END IF; END IF;
    IF TG_TABLE_NAME = 'cargo_instruction' THEN IF
       (NEW.id, NEW.case_id, NEW.action, NEW.destination, NEW.details, NEW.issued_by, NEW.issuer_organisation_id,
            NEW.authority_id, NEW.emergency, NEW.issued_at)
           IS NOT DISTINCT FROM (OLD.id, OLD.case_id, OLD.action, OLD.destination, OLD.details, OLD.issued_by,
                                 OLD.issuer_organisation_id, OLD.authority_id, OLD.emergency, OLD.issued_at)
       AND OLD.state NOT IN ('completed', 'failed', 'declined', 'not_feasible', 'withdrawn')
       AND (OLD.offered_at IS NULL OR (NEW.feasible, NEW.offer_eta, NEW.offer_note, NEW.offered_by, NEW.offered_at)
                                      IS NOT DISTINCT FROM (OLD.feasible, OLD.offer_eta, OLD.offer_note, OLD.offered_by, OLD.offered_at))
       AND (OLD.decided_at IS NULL OR (NEW.decided_by, NEW.decided_at, NEW.approval_basis, NEW.approved_total)
                                      IS NOT DISTINCT FROM (OLD.decided_by, OLD.decided_at, OLD.approval_basis, OLD.approved_total))
       AND NEW.row_version = OLD.row_version + 1 THEN
      RETURN NEW;
    END IF; END IF;
    IF TG_TABLE_NAME = 'trip_leg' THEN IF
       (NEW.id, NEW.trip_id, NEW.instruction_id, NEW.kind, NEW.destination, NEW.created_at)
           IS NOT DISTINCT FROM (OLD.id, OLD.trip_id, OLD.instruction_id, OLD.kind, OLD.destination, OLD.created_at)
       AND OLD.state <> 'completed'
       AND array_position(ARRAY['planned', 'departed', 'arrived', 'completed'], NEW.state)
           = array_position(ARRAY['planned', 'departed', 'arrived', 'completed'], OLD.state) + 1 THEN
      RETURN NEW;
    END IF; END IF;
    IF TG_TABLE_NAME = 'exception_cost' THEN IF
       (NEW.id, NEW.case_id, NEW.instruction_id, NEW.line_no, NEW.kind, NEW.description, NEW.quantity, NEW.unit, NEW.unit_amount,
            NEW.amount, NEW.currency_code, NEW.offered_by, NEW.offered_by_organisation_id, NEW.offered_at,
            NEW.terms_version_id, NEW.provisional_liability)
           IS NOT DISTINCT FROM
           (OLD.id, OLD.case_id, OLD.instruction_id, OLD.line_no, OLD.kind, OLD.description, OLD.quantity, OLD.unit, OLD.unit_amount,
            OLD.amount, OLD.currency_code, OLD.offered_by, OLD.offered_by_organisation_id, OLD.offered_at,
            OLD.terms_version_id, OLD.provisional_liability)
       AND (OLD.interim_payer = 'not_set' OR NEW.interim_payer = OLD.interim_payer)
       AND (OLD.final_liability IS NULL OR (NEW.final_liability, NEW.final_source, NEW.final_reference,
                                            NEW.final_recorded_by, NEW.final_recorded_at)
                                           IS NOT DISTINCT FROM (OLD.final_liability, OLD.final_source, OLD.final_reference,
                                                                 OLD.final_recorded_by, OLD.final_recorded_at)) THEN
      RETURN NEW;
    END IF; END IF;
    IF TG_TABLE_NAME = 'carrier_claim' THEN IF
       (NEW.id, NEW.case_id, NEW.raised_by, NEW.raised_by_organisation_id, NEW.raised_at, NEW.description, NEW.cost_ids)
           IS NOT DISTINCT FROM (OLD.id, OLD.case_id, OLD.raised_by, OLD.raised_by_organisation_id, OLD.raised_at,
                                 OLD.description, OLD.cost_ids)
       AND OLD.state = 'open' AND NEW.state <> 'open' THEN
      RETURN NEW;
    END IF; END IF;
    IF TG_TABLE_NAME = 'settlement_hold' THEN IF
       (NEW.id, NEW.booking_id, NEW.owner_kind, NEW.owner_id, NEW.cost_ids, NEW.reason, NEW.placed_by, NEW.placed_at)
           IS NOT DISTINCT FROM (OLD.id, OLD.booking_id, OLD.owner_kind, OLD.owner_id, OLD.cost_ids, OLD.reason,
                                 OLD.placed_by, OLD.placed_at)
       AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
      RETURN NEW;
    END IF; END IF;
  END IF;
  RAISE EXCEPTION 'this record only moves forward and is never removed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER cargo_case_guard BEFORE UPDATE OR DELETE ON trucker.cargo_case FOR EACH ROW EXECUTE FUNCTION trucker.guard_cargo_record();
CREATE TRIGGER cargo_instruction_guard BEFORE UPDATE OR DELETE ON trucker.cargo_instruction FOR EACH ROW EXECUTE FUNCTION trucker.guard_cargo_record();
CREATE TRIGGER trip_leg_guard BEFORE UPDATE OR DELETE ON trucker.trip_leg FOR EACH ROW EXECUTE FUNCTION trucker.guard_cargo_record();
CREATE TRIGGER exception_cost_guard BEFORE UPDATE OR DELETE ON trucker.exception_cost FOR EACH ROW EXECUTE FUNCTION trucker.guard_cargo_record();
CREATE TRIGGER carrier_claim_guard BEFORE UPDATE OR DELETE ON trucker.carrier_claim FOR EACH ROW EXECUTE FUNCTION trucker.guard_cargo_record();
CREATE TRIGGER settlement_hold_guard BEFORE UPDATE OR DELETE ON trucker.settlement_hold FOR EACH ROW EXECUTE FUNCTION trucker.guard_cargo_record();
CREATE TRIGGER cargo_handover_receipt_guard BEFORE UPDATE OR DELETE ON trucker.cargo_handover_receipt FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER cargo_command_guard BEFORE UPDATE OR DELETE ON trucker.cargo_command FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER cargo_case_truncate_guard BEFORE TRUNCATE ON trucker.cargo_case FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER cargo_instruction_truncate_guard BEFORE TRUNCATE ON trucker.cargo_instruction FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_leg_truncate_guard BEFORE TRUNCATE ON trucker.trip_leg FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER exception_cost_truncate_guard BEFORE TRUNCATE ON trucker.exception_cost FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER carrier_claim_truncate_guard BEFORE TRUNCATE ON trucker.carrier_claim FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER settlement_hold_truncate_guard BEFORE TRUNCATE ON trucker.settlement_hold FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER cargo_handover_receipt_truncate_guard BEFORE TRUNCATE ON trucker.cargo_handover_receipt FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER cargo_command_truncate_guard BEFORE TRUNCATE ON trucker.cargo_command FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

ALTER TABLE trucker.instruction_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.delivery_shortfall ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.cargo_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.cargo_instruction ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.trip_leg ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.exception_cost ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.carrier_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.settlement_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.cargo_handover_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.cargo_command ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.instruction_authority, trucker.delivery_shortfall, trucker.cargo_case, trucker.cargo_instruction,
  trucker.trip_leg, trucker.exception_cost, trucker.carrier_claim, trucker.settlement_hold, trucker.cargo_handover_receipt,
  trucker.cargo_command FROM trucker_app, PUBLIC;

ALTER TABLE trucker.audit_entry
  DROP CONSTRAINT audit_entry_action_check,
  ADD CONSTRAINT audit_entry_action_check CHECK (action IN (
    'organisation.created', 'organisation.updated', 'shipment.created', 'shipment.updated',
    'shipment.discarded', 'shipment.published', 'shipment.version_created',
    'shipment.withdrawn', 'shipment.expired', 'shipment.republished', 'shipment.copied',
    'shipment.suspended', 'shipment.suspension_ended', 'shipment.quotation_terms_set',
    'shipment.awarded', 'verification.submitted', 'verification.withdrawn',
    'verification.claim_raised', 'verification.decided', 'verification.revoked',
    'capability.revalidated', 'quotation.submitted', 'quotation.revised',
    'quotation.reconfirmed', 'quotation.withdrawn', 'quotation.rejected', 'quotation.expired',
    'quotation.closed', 'quotation.reconfirmation_required', 'quotation.accepted',
    'quotation.not_selected', 'acceptance.refused', 'vehicle.registered', 'vehicle.retired',
    'vehicle.ownership_decided', 'fleet_document.submitted', 'fleet_document.decided',
    'driver.invited', 'driver.invitation_cancelled', 'driver.invitation_declined',
    'driver.affiliation_accepted', 'driver.affiliation_ended', 'driver.authorised',
    'driver.authorisation_revoked', 'fleet.suspended', 'fleet.suspension_ended',
    'booking.created', 'booking.assignment_changed', 'booking.confirmed',
    'booking.wait_decided', 'substitution.proposed', 'substitution.accepted',
    'substitution.declined', 'substitution.withdrawn', 'substitution.checks_failed',
    'assignment.acknowledged', 'booking.cancelled', 'booking.vehicles_changed',
    'authority.requested', 'authority.decided', 'authority.ended', 'shipment.parties_set',
    'shipment.commission_set', 'commission_contract.proposed', 'commission_contract.decided',
    'commission_contract.ended', 'booking.fee_paid', 'booking.lapsed',
    'booking.refund_recorded', 'booking.dispatched', 'trip.milestone_recorded',
    'trip.estimate_stated', 'trip.exception_reported', 'trip.case_opened', 'trip.case_updated',
    'booking.dispatch_blocked', 'booking.dispatch_unblocked', 'trip.held', 'trip.resumed',
    'trip.milestone_withdrawn', 'trip.delivery_recorded', 'trip.cargo_handed_over',
    'booking.resource_released', 'booking.instruction_authority_declared',
    'booking.instruction_authority_ended', 'trip.cargo_instructed', 'trip.cargo_emergency',
    'trip.cargo_offered', 'trip.cargo_decided', 'trip.cargo_executed', 'trip.cargo_receipt',
    'trip.leg_progressed', 'booking.hold_placed', 'trip.cargo_authority_order',
    'trip.cargo_case_closed', 'trip.cargo_liability_recorded', 'trip.cargo_claim_decided',
    'booking.hold_released', 'trip.cargo_escalated'
  )),
  DROP CONSTRAINT audit_entry_one_actor,
  ADD CONSTRAINT audit_entry_one_actor CHECK (
    (actor_person_id IS NULL) <> (actor_staff_id IS NULL)
    OR (actor_person_id IS NULL AND actor_staff_id IS NULL AND action IN (
      'shipment.expired', 'shipment.suspended', 'shipment.suspension_ended', 'quotation.expired',
    'quotation.closed', 'quotation.reconfirmation_required', 'booking.lapsed',
    'booking.fee_paid', 'booking.refund_recorded', 'booking.confirmed', 'trip.case_opened',
    'trip.cargo_escalated'
    )));

-- ---------------------------------------------------------------------------------------------
-- Quantities: what is still on the vehicle (sections 7 and 8)
-- ---------------------------------------------------------------------------------------------
-- Cargo left after the outcome in force, less what was handed over with the receiving side's
-- confirmation, less what legs of the trip delivered. An unconfirmed handover moves nothing.
CREATE FUNCTION trucker.cargo_on_vehicle(p_trip uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  WITH o AS (SELECT x.* FROM trucker.trip_delivery_outcome x WHERE x.trip_id = p_trip ORDER BY x.version DESC LIMIT 1)
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM o) OR NOT (SELECT o.cargo_remains FROM o) THEN 0
    -- An outcome from before quantities were recorded: in custody until a confirmed handover.
    WHEN NOT EXISTS (SELECT 1 FROM trucker.delivery_shortfall f JOIN o ON o.id = f.outcome_id) THEN
      CASE WHEN EXISTS (SELECT 1 FROM trucker.cargo_handover h JOIN o ON o.id = h.outcome_id
                        JOIN trucker.cargo_handover_receipt r ON r.handover_id = h.id AND r.state = 'confirmed')
           THEN 0 ELSE 1 END
    ELSE greatest(0,
      (SELECT f.quantity_remaining FROM trucker.delivery_shortfall f JOIN o ON o.id = f.outcome_id)
      - coalesce((SELECT sum(h.quantity) FROM trucker.cargo_handover h JOIN o ON o.id = h.outcome_id
                  JOIN trucker.cargo_handover_receipt r ON r.handover_id = h.id AND r.state = 'confirmed'), 0)
      - coalesce((SELECT sum(l.quantity_delivered) FROM trucker.trip_leg l WHERE l.trip_id = p_trip AND l.state = 'completed'), 0))
  END
$$;

-- What can still be handed over: on the vehicle, less handovers awaiting the receiver's confirmation.
CREATE FUNCTION trucker.cargo_available_on_vehicle(p_trip uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT trucker.cargo_on_vehicle(p_trip)
         - coalesce((SELECT sum(coalesce(h.quantity, 1)) FROM trucker.cargo_handover h
                     JOIN trucker.trip_delivery_outcome o ON o.id = h.outcome_id
                     WHERE h.trip_id = p_trip
                       AND o.version = (SELECT max(x.version) FROM trucker.trip_delivery_outcome x WHERE x.trip_id = p_trip)
                       AND NOT EXISTS (SELECT 1 FROM trucker.cargo_handover_receipt r WHERE r.handover_id = h.id)), 0)
$$;

-- Billable waiting at delivery, in minutes: from arrival at delivery to now or to the truck's
-- release, whichever is earlier, less the free waiting of the booking's terms. Nothing after release.
CREATE FUNCTION trucker.billable_waiting_minutes(b trucker.booking, p_trip uuid, p_at timestamptz) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT greatest(0, floor(extract(epoch FROM (
           least(p_at, coalesce((SELECT r.released_at FROM trucker.resource_release r
                                 WHERE r.booking_id = b.id AND r.role = 'truck'), p_at))
           - m.stated_at)) / 60)::integer - (trucker.booking_terms_version(b)).free_waiting_minutes)
  FROM trucker.trip_milestone m
  WHERE m.trip_id = p_trip AND m.milestone = 'arrived_at_delivery'
    AND NOT EXISTS (SELECT 1 FROM trucker.trip_milestone_withdrawal w WHERE w.milestone_id = m.id)
$$;

-- ---------------------------------------------------------------------------------------------
-- Changed from 0030: the outcome records the shortfall and opens the case; handovers record
-- quantities; release waits for cargo off the vehicle and for legs to finish
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.delivery_outcome_add(b trucker.booking, p_expected_version integer, p_content jsonb,
                                             p_driver uuid, p_actor uuid, p_staff uuid, p_at timestamptz,
                                             OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  tr trucker.trip;
  v_current integer;
  v_outcome text := p_content ->> 'outcome';
  v_receiver text := nullif(btrim(coalesce(p_content ->> 'receiverName', '')), '');
  v_remarks text := nullif(btrim(coalesce(p_content ->> 'remarks', '')), '');
  v_reason text := p_content ->> 'reason';
  v_note text := nullif(btrim(coalesce(p_content ->> 'note', '')), '');
  v_remains boolean;
  v_stated timestamptz;
  v_audience text := CASE WHEN p_staff IS NOT NULL THEN 'operations' WHEN v_reason IS NULL THEN 'driver' ELSE 'carrier' END;
  problems jsonb := '[]'::jsonb;
  c trucker.trip_case;
  sf jsonb := coalesce(p_content -> 'shortfall', '{}'::jsonb);
  v_unit text := nullif(btrim(coalesce(sf ->> 'quantityUnit', '')), '');
  v_delivered numeric;
  v_left numeric;
  v_attempts integer;
  v_outcome_id uuid;
  v_terms trucker.financial_setting_version;
  v_class text;
BEGIN
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  IF tr.milestone_count < array_position(trucker.trip_milestones(), 'arrived_at_delivery') THEN
    status := 'not_arrived';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.trip_hold h WHERE h.trip_id = tr.id AND h.resumed_at IS NULL) THEN
    status := 'on_hold';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  v_current := coalesce((SELECT max(o.version) FROM trucker.trip_delivery_outcome o WHERE o.trip_id = tr.id), 0);
  IF p_staff IS NULL AND v_current > 0 THEN
    status := 'already_recorded';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM v_current THEN
    status := 'conflict';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  IF v_current > 0 AND (EXISTS (SELECT 1 FROM trucker.cargo_handover h WHERE h.trip_id = tr.id)
                        OR EXISTS (SELECT 1 FROM trucker.cargo_instruction i JOIN trucker.cargo_case k ON k.id = i.case_id
                                   WHERE k.trip_id = tr.id)
                        OR EXISTS (SELECT 1 FROM trucker.resource_release r WHERE r.booking_id = b.id)) THEN
    status := 'settled';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  -- What is said and its shape (DL-2).
  IF v_outcome IS NULL OR NOT v_outcome = ANY (trucker.delivery_outcomes()) THEN
    problems := problems || jsonb_build_object('field', 'outcome', 'code', 'invalid');
  END IF;
  v_remains := CASE WHEN v_outcome = 'delivered_in_full' THEN false
                    WHEN v_outcome IN ('partly_delivered', 'refused', 'not_delivered') THEN true
                    ELSE coalesce((p_content ->> 'cargoRemains')::boolean, false) END;
  IF v_receiver IS NULL AND v_outcome NOT IN ('refused', 'not_delivered') THEN
    problems := problems || jsonb_build_object('field', 'receiverName', 'code', 'required');
  END IF;
  IF char_length(coalesce(v_receiver, '')) > 200 THEN
    problems := problems || jsonb_build_object('field', 'receiverName', 'code', 'too_long');
  END IF;
  IF v_remarks IS NULL AND v_outcome IS DISTINCT FROM 'delivered_in_full' THEN
    problems := problems || jsonb_build_object('field', 'remarks', 'code', 'required');
  END IF;
  IF char_length(coalesce(v_remarks, '')) > 2000 THEN
    problems := problems || jsonb_build_object('field', 'remarks', 'code', 'too_long');
  END IF;
  IF p_actor IS NOT NULL AND p_actor = p_driver AND v_reason IS NULL THEN
    v_stated := p_at;
  ELSE
    BEGIN
      v_stated := (p_content ->> 'statedAt')::timestamptz;
    EXCEPTION WHEN others THEN
      v_stated := NULL;
    END;
    IF v_stated IS NULL OR v_stated > p_at THEN
      problems := problems || jsonb_build_object('field', 'statedAt', 'code', CASE WHEN v_stated IS NULL THEN 'invalid' ELSE 'future' END);
    END IF;
    IF v_reason IS NULL OR v_reason NOT IN ('no_phone', 'no_signal', 'driver_unable', 'correction', 'other')
       OR (v_current > 0 AND v_reason <> 'correction') THEN
      problems := problems || jsonb_build_object('field', 'reason', 'code', 'invalid');
    END IF;
    IF v_note IS NULL AND (v_reason = 'other' OR v_current > 0) THEN
      problems := problems || jsonb_build_object('field', 'note', 'code', 'required');
    END IF;
    IF char_length(coalesce(v_note, '')) > 1000 THEN
      problems := problems || jsonb_build_object('field', 'note', 'code', 'too_long');
    END IF;
  END IF;
  -- Undeliverable or refused cargo: why, where, its condition and the quantities (R-406, section 4).
  IF v_remains THEN
    IF NOT coalesce(sf ->> 'reason', '') = ANY (trucker.shortfall_reasons()) THEN
      problems := problems || jsonb_build_object('field', 'shortfall.reason', 'code', 'invalid');
    END IF;
    IF nullif(btrim(coalesce(sf ->> 'location', '')), '') IS NULL OR char_length(sf ->> 'location') > 500 THEN
      problems := problems || jsonb_build_object('field', 'shortfall.location', 'code', 'required');
    END IF;
    IF nullif(btrim(coalesce(sf ->> 'cargoCondition', '')), '') IS NULL OR char_length(sf ->> 'cargoCondition') > 1000 THEN
      problems := problems || jsonb_build_object('field', 'shortfall.cargoCondition', 'code', 'required');
    END IF;
    IF v_unit IS NULL OR char_length(v_unit) > 40 THEN
      problems := problems || jsonb_build_object('field', 'shortfall.quantityUnit', 'code', 'required');
    END IF;
    BEGIN
      v_delivered := (sf ->> 'quantityDelivered')::numeric;
      v_left := (sf ->> 'quantityRemaining')::numeric;
      v_attempts := (sf ->> 'contactAttempts')::integer;
    EXCEPTION WHEN others THEN
      v_delivered := NULL;
    END;
    IF v_delivered IS NULL OR v_delivered < 0 OR v_left IS NULL OR v_left <= 0 OR v_attempts IS NULL
       OR v_attempts NOT BETWEEN 0 AND 100
       OR (v_outcome IN ('refused', 'not_delivered') AND v_delivered <> 0)
       OR (v_outcome = 'partly_delivered' AND v_delivered = 0) THEN
      problems := problems || jsonb_build_object('field', 'shortfall.quantities', 'code', 'invalid');
    END IF;
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  INSERT INTO trucker.trip_delivery_outcome (trip_id, version, outcome, receiver_name, remarks, cargo_remains, stated_at,
                                             recorded_at, basis, driver_id, recorded_by, recorded_by_staff, reason, note)
  VALUES (tr.id, v_current + 1, v_outcome, v_receiver, v_remarks, v_remains, v_stated, p_at,
          CASE WHEN v_reason IS NULL THEN 'observed' ELSE 'reported' END, p_driver, p_actor, p_staff, v_reason, v_note)
  RETURNING id INTO v_outcome_id;
  IF v_remains THEN
    INSERT INTO trucker.delivery_shortfall (outcome_id, reason, refusal_reason, location, cargo_condition, quantity_unit,
                                            quantity_delivered, quantity_remaining, contact_attempts, contact_note,
                                            evidence_note)
    VALUES (v_outcome_id, sf ->> 'reason', nullif(btrim(coalesce(sf ->> 'refusalReason', '')), ''),
            btrim(sf ->> 'location'), btrim(sf ->> 'cargoCondition'), v_unit, v_delivered, v_left, v_attempts,
            nullif(btrim(coalesce(sf ->> 'contactNote', '')), ''), nullif(btrim(coalesce(sf ->> 'evidenceNote', '')), ''));
    -- A case opens; nothing is recorded as delivered or cancelled by it (section 4).
    v_terms := trucker.booking_terms_version(b);
    v_class := trucker.booking_cargo_class(b);
    INSERT INTO trucker.cargo_case (booking_id, trip_id, cargo_class, opened_at, response_due_at, escalate_at)
    SELECT b.id, tr.id, v_class, p_at, p_at + m * interval '1 minute', p_at + (m + v_terms.escalation_minutes) * interval '1 minute'
    FROM (SELECT CASE v_class WHEN 'dangerous' THEN v_terms.response_minutes_dangerous
                              WHEN 'temperature' THEN v_terms.response_minutes_temperature
                              ELSE v_terms.response_minutes_general END AS m) x
    ON CONFLICT (trip_id) DO NOTHING;
  END IF;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id, request_id,
     after_values)
  SELECT p_at, p_actor, p_staff, o, 'trip.delivery_recorded', 'booking', b.id,
         nullif(current_setting('trucker.request_id', true), ''),
         jsonb_build_object('outcome', v_outcome, 'version', v_current + 1, 'cargoRemains', v_remains,
                            'basis', CASE WHEN v_reason IS NULL THEN 'observed' ELSE 'reported' END,
                            'onBehalfOf', CASE WHEN v_reason IS NOT NULL THEN p_driver END, 'reason', v_reason)
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
  -- Anything but delivered in full: one operations case for the trip (DLV-3).
  IF v_outcome <> 'delivered_in_full' THEN
    INSERT INTO trucker.trip_case (trip_id, booking_id, kind, reported_as, reported_at)
    VALUES (tr.id, b.id, 'delivery_outcome', 'system', p_at)
    ON CONFLICT (trip_id, kind) WHERE kind <> 'exception' DO NOTHING
    RETURNING * INTO c;
    IF c.id IS NOT NULL THEN
      INSERT INTO trucker.audit_entry (occurred_at, organisation_id, action, record_type, record_id, after_values)
      SELECT p_at, o, 'trip.case_opened', 'booking', b.id, jsonb_build_object('case', c.id, 'kind', c.kind)
      FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
    END IF;
  END IF;
  status := 'recorded';
  detail := trucker.trip_values(b.id, v_audience);
END
$$;

CREATE OR REPLACE FUNCTION trucker.cargo_handover_add(b trucker.booking, p_content jsonb, p_actor uuid, p_staff uuid,
                                           p_at timestamptz, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  tr trucker.trip;
  o trucker.trip_delivery_outcome;
  v_kind text := p_content ->> 'kind';
  v_by text := nullif(btrim(coalesce(p_content ->> 'handedBy', '')), '');
  v_to text := nullif(btrim(coalesce(p_content ->> 'receivedBy', '')), '');
  v_place text := nullif(btrim(coalesce(p_content ->> 'place', '')), '');
  v_note text := nullif(btrim(coalesce(p_content ->> 'note', '')), '');
  v_at timestamptz;
  v_audience text := CASE WHEN p_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END;
  problems jsonb := '[]'::jsonb;
  v_quantity numeric;
  v_available numeric;
  v_instruction uuid;
BEGIN
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  SELECT * INTO o FROM trucker.trip_delivery_outcome x WHERE x.trip_id = tr.id ORDER BY x.version DESC LIMIT 1;
  v_available := trucker.cargo_available_on_vehicle(tr.id);
  IF o.id IS NULL OR NOT o.cargo_remains OR v_available <= 0 THEN
    status := 'no_custody';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  BEGIN
    v_at := (p_content ->> 'handedAt')::timestamptz;
  EXCEPTION WHEN others THEN
    v_at := NULL;
  END;
  BEGIN
    v_quantity := (p_content ->> 'quantity')::numeric;
    v_instruction := (p_content ->> 'instructionId')::uuid;
  EXCEPTION WHEN others THEN
    v_quantity := NULL;
  END;
  IF v_quantity IS NULL OR v_quantity <= 0 OR v_quantity > v_available THEN
    problems := problems || jsonb_build_object('field', 'quantity', 'code', 'invalid');
  END IF;
  IF v_instruction IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trucker.cargo_instruction i JOIN trucker.cargo_case k ON k.id = i.case_id
                                               WHERE i.id = v_instruction AND k.trip_id = tr.id) THEN
    problems := problems || jsonb_build_object('field', 'instructionId', 'code', 'invalid');
  END IF;
  IF nullif(btrim(coalesce(p_content ->> 'condition', '')), '') IS NULL
     OR nullif(btrim(coalesce(p_content ->> 'receivedByStanding', '')), '') IS NULL
     OR nullif(btrim(coalesce(p_content ->> 'handedByStanding', '')), '') IS NULL THEN
    problems := problems || jsonb_build_object('field', 'condition', 'code', 'required');
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('returned_to_shipper', 'delivered_elsewhere', 'replacement_vehicle', 'warehouse',
                                      'alternate_carrier', 'consignee') THEN
    problems := problems || jsonb_build_object('field', 'kind', 'code', 'invalid');
  END IF;
  IF v_by IS NULL OR char_length(v_by) > 200 THEN
    problems := problems || jsonb_build_object('field', 'handedBy', 'code', CASE WHEN v_by IS NULL THEN 'required' ELSE 'too_long' END);
  END IF;
  IF v_to IS NULL OR char_length(v_to) > 200 THEN
    problems := problems || jsonb_build_object('field', 'receivedBy', 'code', CASE WHEN v_to IS NULL THEN 'required' ELSE 'too_long' END);
  END IF;
  IF v_place IS NULL OR char_length(v_place) > 500 THEN
    problems := problems || jsonb_build_object('field', 'place', 'code', CASE WHEN v_place IS NULL THEN 'required' ELSE 'too_long' END);
  END IF;
  -- Times are entered to the minute: the minute of the outcome itself is accepted.
  IF v_at IS NULL OR v_at > p_at OR v_at < date_trunc('minute', o.stated_at) THEN
    problems := problems || jsonb_build_object('field', 'handedAt', 'code', CASE WHEN v_at IS NULL THEN 'invalid'
                                                                                 WHEN v_at > p_at THEN 'future' ELSE 'before_outcome' END);
  END IF;
  IF char_length(coalesce(v_note, '')) > 1000 THEN
    problems := problems || jsonb_build_object('field', 'note', 'code', 'too_long');
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  INSERT INTO trucker.cargo_handover (trip_id, outcome_id, kind, handed_by, received_by, handed_at, place, note,
                                      recorded_by, recorded_by_staff, recorded_at, quantity, quantity_unit, condition,
                                      evidence_note, handed_by_standing, received_by_standing, instruction_id)
  VALUES (tr.id, o.id, v_kind, v_by, v_to, v_at, v_place, v_note, p_actor, p_staff, p_at, v_quantity,
          (SELECT f.quantity_unit FROM trucker.delivery_shortfall f WHERE f.outcome_id = o.id),
          left(btrim(p_content ->> 'condition'), 1000), nullif(left(btrim(coalesce(p_content ->> 'evidenceNote', '')), 1000), ''),
          left(btrim(p_content ->> 'handedByStanding'), 300), left(btrim(p_content ->> 'receivedByStanding'), 300),
          v_instruction);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id, request_id,
     after_values)
  SELECT p_at, p_actor, p_staff, x, 'trip.cargo_handed_over', 'booking', b.id,
         nullif(current_setting('trucker.request_id', true), ''), jsonb_build_object('kind', v_kind, 'handedAt', v_at)
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) x;
  status := 'recorded';
  detail := trucker.trip_values(b.id, v_audience);
END
$$;

CREATE OR REPLACE FUNCTION trucker.resource_release_add(b trucker.booking, p_role text, p_actor uuid, p_staff uuid,
                                             p_override boolean, p_note text, p_at timestamptz,
                                             OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  tr trucker.trip;
  o trucker.trip_delivery_outcome;
  a trucker.booking_assignment;
  ep trucker.occupancy_episode;
  v_custody_open boolean;
  v_audience text := CASE WHEN p_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('truck', 'trailer', 'driver') THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'role', 'code', 'invalid'));
    RETURN;
  END IF;
  IF (p_override AND v_note IS NULL) OR char_length(coalesce(v_note, '')) > 1000 THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'note', 'code', CASE WHEN v_note IS NULL THEN 'required' ELSE 'too_long' END));
    RETURN;
  END IF;
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  SELECT * INTO a FROM trucker.booking_assignment x WHERE x.booking_id = b.id AND x.role = p_role AND x.status = 'active';
  IF NOT FOUND THEN
    status := 'not_assigned';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  SELECT * INTO ep FROM trucker.occupancy_episode e WHERE e.reservation_id = a.reservation_id FOR UPDATE;
  IF ep.closed_at IS NOT NULL THEN
    status := 'already_released';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  SELECT * INTO o FROM trucker.trip_delivery_outcome x WHERE x.trip_id = tr.id ORDER BY x.version DESC LIMIT 1;
  IF o.id IS NULL THEN
    status := 'no_outcome';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  -- The release condition (DI-403): nothing left on the vehicle, or its handover recorded; or
  -- operations releasing with a note (REL-2).
  -- Cargo still on the vehicle (its handover not confirmed), or a leg of the trip still under way
  -- with these resources: the resource is not free (R-406, section 7 and 8).
  -- A leg under way is these resources still at work: never released, by anyone, while it runs.
  IF EXISTS (SELECT 1 FROM trucker.trip_leg l WHERE l.trip_id = tr.id AND l.state <> 'completed') THEN
    status := 'leg_under_way';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  v_custody_open := trucker.cargo_on_vehicle(tr.id) > 0;
  IF v_custody_open AND NOT (p_override AND p_staff IS NOT NULL) THEN
    status := 'custody_open';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  INSERT INTO trucker.resource_release (booking_id, episode_id, reservation_id, role, released_by, released_by_staff,
                                        released_at, basis, note)
  VALUES (b.id, ep.id, a.reservation_id, p_role, p_actor, p_staff, p_at,
          CASE WHEN v_custody_open THEN 'operations' ELSE 'condition' END, v_note);
  UPDATE trucker.occupancy_episode e SET closed_at = p_at, release_reason = 'released' WHERE e.id = ep.id;
  UPDATE trucker.resource_reservation r
  SET status = 'released', released_at = p_at, release_reason = 'trip_released'
  WHERE r.id = a.reservation_id;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id, request_id,
     after_values)
  VALUES (p_at, p_actor, p_staff, b.carrier_organisation_id, 'booking.resource_released', 'booking', b.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('role', p_role, 'basis', CASE WHEN v_custody_open THEN 'operations' ELSE 'condition' END));
  status := 'released';
  detail := trucker.trip_values(b.id, v_audience);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- What each party sees (section 11; test 13: isolation)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.cargo_cost_values(c trucker.exception_cost, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'description', c.description, 'quantity', trim_scale(c.quantity)::text, 'unit', c.unit,
    'unitAmount', trucker.amount_text(c.unit_amount, m.minor_units), 'amount', trucker.amount_text(c.amount, m.minor_units),
    'currency', c.currency_code, 'offeredAt', c.offered_at,
    'termsVersion', (SELECT v.version_no FROM trucker.financial_setting_version v WHERE v.id = c.terms_version_id),
    'interimPayer', c.interim_payer, 'provisionalLiability', c.provisional_liability,
    'finalLiability', c.final_liability, 'finalSource', c.final_source, 'finalReference', c.final_reference,
    'held', EXISTS (SELECT 1 FROM trucker.settlement_hold h WHERE c.id = ANY (h.cost_ids) AND h.released_at IS NULL))
  FROM (SELECT bk.minor_units FROM trucker.cargo_case k JOIN trucker.booking bk ON bk.id = k.booking_id
        WHERE k.id = c.case_id) m
$$;

CREATE FUNCTION trucker.cargo_values(p_trip uuid, p_audience text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  k trucker.cargo_case;
  b trucker.booking;
  v_driver boolean := p_audience = 'driver';
BEGIN
  SELECT * INTO k FROM trucker.cargo_case x WHERE x.trip_id = p_trip;
  SELECT bk.* INTO b FROM trucker.booking bk JOIN trucker.trip t ON t.booking_id = bk.id WHERE t.id = p_trip;
  RETURN jsonb_build_object(
    'authorities', CASE WHEN v_driver THEN NULL ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', a.id, 'holder', (SELECT o.legal_name FROM trucker.organisation o WHERE o.id = a.holder_organisation_id),
               'holderRole', a.holder_role, 'basis', a.basis, 'basisNote', a.basis_note, 'actions', to_jsonb(a.actions),
               'spendLimit', trucker.amount_text(a.spend_limit, b.minor_units), 'currency', a.currency_code, 'validUntil', a.valid_until,
               'alternateContact', CASE WHEN p_audience IN ('shipper', 'operations', 'organiser') THEN a.alternate_contact END,
               'declaredAt', a.declared_at, 'endedAt', a.ended_at, 'endReason', a.end_reason)
             ORDER BY a.declared_at)
      FROM trucker.instruction_authority a WHERE a.booking_id = b.id), '[]'::jsonb) END,
    'onVehicle', trucker.cargo_on_vehicle(p_trip),
    'case', CASE WHEN k.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', k.id, 'version', k.row_version, 'cargoClass', k.cargo_class, 'openedAt', k.opened_at,
      'responseDueAt', k.response_due_at, 'escalateAt', k.escalate_at, 'escalatedAt', k.escalated_at,
      'authorityOrder', k.authority_order, 'authorityAllowedActions', to_jsonb(k.authority_allowed_actions),
      'closedAt', k.closed_at, 'closeNote', CASE WHEN p_audience = 'operations' THEN k.close_note END,
      'shortfall', (SELECT jsonb_build_object(
                      'reason', f.reason, 'refusalReason', f.refusal_reason, 'location', f.location,
                      'cargoCondition', f.cargo_condition, 'quantityUnit', f.quantity_unit,
                      'quantityDelivered', f.quantity_delivered, 'quantityRemaining', f.quantity_remaining,
                      'contactAttempts', f.contact_attempts, 'contactNote', f.contact_note, 'evidenceNote', f.evidence_note)
                    FROM trucker.delivery_shortfall f JOIN trucker.trip_delivery_outcome o ON o.id = f.outcome_id
                    WHERE o.trip_id = p_trip ORDER BY o.version DESC LIMIT 1),
      'instructions', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', i.id, 'version', i.row_version, 'action', i.action, 'destination', i.destination,
                 'details', i.details, 'state', i.state, 'emergency', i.emergency, 'issuedAt', i.issued_at,
                 'issuer', (SELECT o.legal_name FROM trucker.organisation o WHERE o.id = i.issuer_organisation_id),
                 'feasible', i.feasible, 'offerEta', i.offer_eta,
                 'offerNote', CASE WHEN v_driver THEN NULL ELSE i.offer_note END,
                 'decidedAt', i.decided_at, 'approvalBasis', i.approval_basis,
                 'approvedTotal', CASE WHEN v_driver THEN NULL ELSE trucker.amount_text(i.approved_total, b.minor_units) END,
                 'startedAt', i.started_at, 'endedAt', i.ended_at, 'executionNote', i.execution_note,
                 'costs', CASE WHEN v_driver THEN NULL ELSE coalesce((
                   SELECT jsonb_agg(trucker.cargo_cost_values(c, p_audience) ORDER BY c.offered_at, c.instruction_id, c.line_no)
                   FROM trucker.exception_cost c WHERE c.instruction_id = i.id), '[]'::jsonb) END)
               ORDER BY i.issued_at, i.id)
        FROM trucker.cargo_instruction i
        -- The driver sees only what was approved for them to do.
        WHERE i.case_id = k.id AND (NOT v_driver OR i.state IN ('approved', 'executing', 'completed'))), '[]'::jsonb),
      'handovers', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', h.id, 'kind', h.kind, 'handedBy', h.handed_by, 'handedByStanding', h.handed_by_standing,
                 'receivedBy', h.received_by, 'receivedByStanding', h.received_by_standing, 'handedAt', h.handed_at,
                 'place', h.place, 'quantity', h.quantity, 'quantityUnit', h.quantity_unit, 'condition', h.condition,
                 'evidenceNote', h.evidence_note,
                 'receipt', (SELECT jsonb_build_object('state', r.state, 'reference', r.reference, 'confirmedAt', r.confirmed_at)
                             FROM trucker.cargo_handover_receipt r WHERE r.handover_id = h.id))
               ORDER BY h.recorded_at, h.id)
        FROM trucker.cargo_handover h WHERE h.trip_id = p_trip), '[]'::jsonb),
      'legs', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', l.id, 'kind', l.kind, 'destination', l.destination, 'state', l.state, 'departedAt', l.departed_at,
                 'arrivedAt', l.arrived_at, 'completedAt', l.completed_at, 'quantityDelivered', l.quantity_delivered,
                 'receiverName', l.receiver_name)
               ORDER BY l.created_at)
        FROM trucker.trip_leg l WHERE l.trip_id = p_trip), '[]'::jsonb),
      'claims', CASE WHEN v_driver THEN NULL ELSE coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', c.id, 'raisedAt', c.raised_at, 'description', c.description, 'costIds', to_jsonb(c.cost_ids),
                 'state', c.state, 'decision', c.decision, 'decisionSource', c.decision_source,
                 'decisionReference', c.decision_reference)
               ORDER BY c.raised_at)
        FROM trucker.carrier_claim c WHERE c.case_id = k.id), '[]'::jsonb) END,
      'holds', CASE WHEN v_driver THEN NULL ELSE coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', h.id, 'ownerKind', h.owner_kind, 'ownerId', h.owner_id, 'costIds', to_jsonb(h.cost_ids),
                 'reason', h.reason, 'placedAt', h.placed_at, 'releasedAt', h.released_at,
                 'releaseNote', CASE WHEN p_audience = 'operations' THEN h.release_note END)
               ORDER BY h.placed_at)
        FROM trucker.settlement_hold h WHERE h.booking_id = b.id), '[]'::jsonb) END,
      'billableWaitingMinutes', CASE WHEN v_driver THEN NULL
                                     ELSE trucker.billable_waiting_minutes(b, p_trip, trucker.clock_now()) END) END);
END
$$;

CREATE OR REPLACE FUNCTION trucker.trip_values(p_booking uuid, p_audience text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'id', t.id, 'version', t.row_version, 'dispatchedAt', t.dispatched_at, 'late', t.late,
    'next', (trucker.trip_milestones())[t.milestone_count + 1],
    'milestones', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'milestone', m.milestone, 'statedAt', m.stated_at, 'recordedAt', m.recorded_at, 'basis', m.basis,
               'about', (SELECT p.display_name FROM trucker.person p WHERE p.id = m.driver_id),
               -- Operations' entries name Trucker operations, not the staff member, to the parties.
               'enteredBy', CASE WHEN m.basis = 'reported' AND m.recorded_by IS NOT NULL
                                 THEN (SELECT p.display_name FROM trucker.person p WHERE p.id = m.recorded_by)
                                 WHEN m.recorded_by_staff IS NOT NULL AND p_audience = 'operations'
                                 THEN (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = m.recorded_by_staff) END,
               'enteredAs', CASE WHEN m.basis = 'observed' THEN 'driver'
                                 WHEN m.recorded_by_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END,
               'reason', m.reason,
               -- The note stays with the carrier.
               'note', CASE WHEN p_audience = 'carrier' AND m.recorded_by IS NOT NULL
                              OR p_audience = 'operations' THEN m.note END,
               'needsReview', m.needs_review)
             ORDER BY m.seq)
      FROM trucker.trip_milestone m WHERE m.trip_id = t.id
        AND NOT EXISTS (SELECT 1 FROM trucker.trip_milestone_withdrawal w WHERE w.milestone_id = m.id)), '[]'::jsonb),
    -- Milestones withdrawn as recorded by mistake stay visible, with when and why (slice 17b).
    'withdrawn', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'milestone', m.milestone, 'statedAt', m.stated_at, 'withdrawnAt', w.withdrawn_at,
               'note', CASE WHEN p_audience = 'operations' THEN w.note END)
             ORDER BY w.withdrawn_at, m.seq)
      FROM trucker.trip_milestone_withdrawal w JOIN trucker.trip_milestone m ON m.id = w.milestone_id
      WHERE w.trip_id = t.id), '[]'::jsonb),
    'hold', (SELECT jsonb_build_object('reason', h.reason, 'heldAt', h.held_at)
                    || CASE WHEN p_audience = 'operations' THEN jsonb_build_object(
                         'note', h.note, 'heldBy', (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = h.held_by))
                       ELSE '{}'::jsonb END
             FROM trucker.trip_hold h WHERE h.trip_id = t.id AND h.resumed_at IS NULL),
    -- The delivery outcome, custody and releases (slice 18a).
    'delivery', trucker.delivery_values(t.id, p_audience),
    -- Undeliverable or refused cargo (R-406).
    'cargo', trucker.cargo_values(t.id, p_audience),
    'cases', coalesce((SELECT jsonb_agg(trucker.trip_case_values(c, p_audience) ORDER BY c.reported_at, c.id)
                       FROM trucker.trip_case c WHERE c.trip_id = t.id), '[]'::jsonb),
    'estimate', (SELECT jsonb_build_object('arrivalAt', e.arrival_at, 'statedAt', e.stated_at, 'statedAs', e.stated_as,
                                           'statedBy', (SELECT p.display_name FROM trucker.person p WHERE p.id = e.stated_by))
                 FROM trucker.trip_estimate e WHERE e.trip_id = t.id ORDER BY e.seq DESC LIMIT 1))
  FROM trucker.trip t WHERE t.booking_id = p_booking
$function$;

-- ---------------------------------------------------------------------------------------------
-- The watch: escalation when nobody answers (section 6)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.cargo_watch(p_at timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  n integer := 0;
  k record;
BEGIN
  FOR k IN
    SELECT x.id, x.booking_id FROM trucker.cargo_case x
    WHERE x.closed_at IS NULL AND x.escalated_at IS NULL AND x.escalate_at <= p_at
      -- Nobody approved anything: silence is never an answer.
      AND NOT EXISTS (SELECT 1 FROM trucker.cargo_instruction i WHERE i.case_id = x.id
                      AND i.state IN ('approved', 'executing', 'completed'))
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE trucker.cargo_case x SET escalated_at = p_at, row_version = row_version + 1 WHERE x.id = k.id;
    INSERT INTO trucker.audit_entry (occurred_at, organisation_id, action, record_type, record_id, after_values)
    SELECT p_at, o, 'trip.cargo_escalated', 'booking', k.booking_id, jsonb_build_object('case', k.id)
    FROM trucker.booking b, unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o WHERE b.id = k.booking_id;
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;

CREATE OR REPLACE FUNCTION trucker.overrun_note(p_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  UPDATE trucker.resource_reservation r SET overrun_recorded_at = p_at
  FROM trucker.occupancy_episode e
  WHERE e.reservation_id = r.id AND e.closed_at IS NULL AND upper(r.planned) < p_at
    AND r.overrun_recorded_at IS NULL;
  INSERT INTO trucker.booking_risk_flag (booking_id, episode_id, recorded_at)
  SELECT DISTINCT later.booking_id, e.id, p_at
  FROM trucker.occupancy_episode e
  JOIN trucker.resource_reservation r ON r.id = e.reservation_id
  JOIN trucker.resource_reservation later
    ON later.resource_id = e.resource_id AND later.status = 'active' AND later.booking_id <> e.booking_id
  WHERE e.closed_at IS NULL AND upper(r.planned) < p_at
  ON CONFLICT DO NOTHING;
  -- One case for each overrunning trip, however often it is seen, linked to every later booking
  -- it puts at risk (EXC-3, N-6). No automatic consequence.
  WITH opened AS (
    INSERT INTO trucker.trip_case (trip_id, booking_id, kind, reported_as, reported_at)
    SELECT DISTINCT t.id, t.booking_id, 'overrun', 'system', p_at
    FROM trucker.occupancy_episode e
    JOIN trucker.resource_reservation r ON r.id = e.reservation_id
    JOIN trucker.trip t ON t.booking_id = e.booking_id
    WHERE e.closed_at IS NULL AND upper(r.planned) < p_at
    ON CONFLICT (trip_id, kind) WHERE kind <> 'exception' DO NOTHING
    RETURNING *)
  INSERT INTO trucker.audit_entry (occurred_at, organisation_id, action, record_type, record_id, after_values)
  SELECT p_at, o, 'trip.case_opened', 'booking', b.id, jsonb_build_object('case', c.id, 'kind', c.kind)
  FROM opened c JOIN trucker.booking b ON b.id = c.booking_id,
       unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
  INSERT INTO trucker.trip_case_booking (case_id, booking_id, linked_at)
  SELECT DISTINCT c.id, f.booking_id, p_at
  FROM trucker.booking_risk_flag f
  JOIN trucker.occupancy_episode e ON e.id = f.episode_id
  JOIN trucker.trip t ON t.booking_id = e.booking_id
  JOIN trucker.trip_case c ON c.trip_id = t.id AND c.kind = 'overrun'
  ON CONFLICT DO NOTHING;
  -- No arrival at pick-up by the end of the pick-up window (DD-9): one case for the trip.
  WITH opened AS (
    INSERT INTO trucker.trip_case (trip_id, booking_id, kind, reported_as, reported_at)
    SELECT t.id, t.booking_id, 'no_pickup_arrival', 'system', p_at
    FROM trucker.trip t JOIN trucker.booking b ON b.id = t.booking_id
    WHERE t.milestone_count < 2
      AND (b.shipment_snapshot #>> '{pickup,until,at}')::timestamptz < p_at
    ON CONFLICT (trip_id, kind) WHERE kind <> 'exception' DO NOTHING
    RETURNING *)
  INSERT INTO trucker.audit_entry (occurred_at, organisation_id, action, record_type, record_id, after_values)
  SELECT p_at, o, 'trip.case_opened', 'booking', b.id, jsonb_build_object('case', c.id, 'kind', c.kind)
  FROM opened c JOIN trucker.booking b ON b.id = c.booking_id,
       unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
  -- Undeliverable cargo nobody answered for: escalated (R-406, section 6).
  PERFORM trucker.cargo_watch(p_at);
END
$function$;

CREATE OR REPLACE FUNCTION trucker.trip_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
DECLARE
  before_count bigint := (SELECT count(*) FROM trucker.trip_case WHERE kind <> 'exception')
                         + (SELECT count(*) FROM trucker.cargo_case WHERE escalated_at IS NOT NULL);
BEGIN
  PERFORM trucker.overrun_note(trucker.clock_now());
  RETURN (SELECT count(*) FROM trucker.trip_case WHERE kind <> 'exception')
         + (SELECT count(*) FROM trucker.cargo_case WHERE escalated_at IS NOT NULL) - before_count;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- Commands (sections 3 to 9)
-- ---------------------------------------------------------------------------------------------
-- The side a signed-in person acts for on a booking: the contracting customer's administrator, the
-- carrier's administrator, the organiser's administrator, or the assigned driver.
CREATE FUNCTION trucker.cargo_side(b trucker.booking, p_org uuid, p_actor uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE
    WHEN p_org IS NULL AND trucker.trip_driver_of(b) = p_actor THEN 'driver'
    WHEN p_org IS NULL THEN NULL
    WHEN NOT trucker.is_admin(p_org) THEN NULL
    WHEN p_org = b.shipper_organisation_id THEN 'shipper'
    WHEN p_org = b.carrier_organisation_id THEN 'carrier'
    WHEN p_org = (SELECT p.organiser_organisation_id FROM trucker.booking_party p WHERE p.booking_id = b.id) THEN 'organiser'
  END
$$;

CREATE FUNCTION trucker.cargo_audit(p_at timestamptz, p_actor uuid, p_staff uuid, b trucker.booking, p_action text,
                                    p_after jsonb) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id, request_id, after_values)
  SELECT p_at, p_actor, p_staff, o, p_action, 'booking', b.id, nullif(current_setting('trucker.request_id', true), ''), p_after
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o
$$;

-- An amount read from text: at most the booking's decimals, never negative.
CREATE FUNCTION trucker.cargo_amount(p_text text, p_minor integer) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_text IS NULL OR p_text !~ ('^[0-9]{1,9}(\.[0-9]{1,' || greatest(p_minor, 1) || '})?$')
     OR (p_minor = 0 AND p_text LIKE '%.%') THEN
    RETURN NULL;
  END IF;
  RETURN p_text::numeric;
END
$$;

-- One command on the cargo of a booking. p_key makes it idempotent: the same key and command
-- return the first answer and change nothing; the same key with another command is refused.
-- Status: the outcome (declared, ended, issued, withdrawn, offered, approved, declined, started,
-- completed, failed, emergency, handed_over, confirmed, rejected, leg_updated, disputed, claimed),
-- or a refusal (not_found, unauthorized, invalid, conflict, no_authority, authority_order,
-- instruction_open, not_open, over_limit, not_due, not_in_plan, over_cap, exceeds_waiting,
-- return_fee_not_allowed, no_case, case_closed, no_cargo, not_dispatched, key_conflict).
CREATE FUNCTION trucker.cargo_command(p_booking uuid, p_key text, p_command jsonb, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  v_side text;
  v_kind text := p_command ->> 'command';
  hash text;
  logged trucker.cargo_command;
  t timestamptz;
  r record;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_side := trucker.cargo_side(b, org, actor);
  IF v_side IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'key', 'code', 'invalid'));
    RETURN;
  END IF;
  hash := trucker.content_hash(jsonb_build_object('booking', b.id, 'command', p_command));
  -- The trip's lock orders every command on this cargo, and every release and leg.
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  SELECT * INTO logged FROM trucker.cargo_command x WHERE x.actor_id = actor AND x.command_key = p_key;
  IF FOUND THEN
    IF logged.command_hash <> hash THEN
      status := 'key_conflict';
      RETURN;
    END IF;
    status := logged.status;
    detail := logged.detail;
    RETURN;
  END IF;
  t := trucker.clock_now();
  -- Still the same person in the same place once the trip is locked (section 3: checked again).
  IF trucker.request_person() IS DISTINCT FROM actor OR trucker.cargo_side(b, org, actor) IS DISTINCT FROM v_side THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO r FROM trucker.cargo_apply(b, v_side, org, actor, NULL, p_command, t);
  status := r.status;
  detail := r.detail;
  IF r.done THEN
    detail := trucker.cargo_values((SELECT x.id FROM trucker.trip x WHERE x.booking_id = b.id),
                                   CASE v_side WHEN 'organiser' THEN 'organiser' ELSE v_side END);
    INSERT INTO trucker.cargo_command (actor_id, command_key, command_hash, status, detail, recorded_at)
    VALUES (actor, p_key, hash, status, detail, t);
  END IF;
END
$$;

-- The same for Trucker operations. Commands: authority_order, close_case, record_liability,
-- decide_claim, release_hold, confirm_receipt.
CREATE FUNCTION trucker.staff_cargo_command(p_token_hash text, p_booking uuid, p_key text, p_command jsonb,
                                            p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  b trucker.booking;
  hash text;
  logged trucker.cargo_command;
  t timestamptz;
  r record;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.cargo', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'key', 'code', 'invalid'));
    RETURN;
  END IF;
  hash := trucker.content_hash(jsonb_build_object('booking', b.id, 'command', p_command));
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  SELECT * INTO logged FROM trucker.cargo_command x WHERE x.actor_id = e.staff_id AND x.command_key = p_key;
  IF FOUND THEN
    IF logged.command_hash <> hash THEN
      status := 'key_conflict';
      RETURN;
    END IF;
    status := logged.status;
    detail := logged.detail;
    RETURN;
  END IF;
  t := trucker.clock_now();
  SELECT * INTO r FROM trucker.cargo_apply(b, 'operations', NULL, NULL, e.staff_id, p_command, t);
  status := r.status;
  detail := r.detail;
  IF r.done THEN
    detail := trucker.cargo_values((SELECT x.id FROM trucker.trip x WHERE x.booking_id = b.id), 'operations');
    INSERT INTO trucker.cargo_command (actor_id, command_key, command_hash, status, detail, recorded_at)
    VALUES (e.staff_id, p_key, hash, status, detail, t);
    PERFORM trucker.staff_audit(t, e.staff_id, 'staff.operations.cargo', 'done', NULL, p_request_id,
                                jsonb_build_object('booking', b.id, 'command', p_command ->> 'command', 'status', status));
  END IF;
END
$$;

-- Applies one command under the trip's lock, for a side. done is true when something was recorded.
CREATE FUNCTION trucker.cargo_apply(b trucker.booking, p_side text, p_org uuid, p_actor uuid, p_staff uuid,
                                    p_command jsonb, p_at timestamptz,
                                    OUT status text, OUT detail jsonb, OUT done boolean)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_kind text := p_command ->> 'command';
  tr trucker.trip;
  k trucker.cargo_case;
  i trucker.cargo_instruction;
  a trucker.instruction_authority;
  terms trucker.financial_setting_version;
  v_note text;
  v_text text;
  v_amount numeric;
  v_total numeric;
  v_actions text[];
  v_holder uuid;
  v_until timestamptz;
  v_version integer := (p_command ->> 'version')::integer;
  v_cost jsonb;
  v_costs jsonb;
  v_ids uuid[];
  v_id uuid;
  v_leg trucker.trip_leg;
  v_claim trucker.carrier_claim;
  v_hold trucker.settlement_hold;
  v_liability text;
  v_waiting integer;
  v_problems jsonb := '[]'::jsonb;
BEGIN
  done := false;
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id;
  SELECT * INTO k FROM trucker.cargo_case x WHERE x.trip_id = tr.id FOR UPDATE;
  terms := trucker.booking_terms_version(b);

  -- Declaring authority: the contracting customer, for itself or as a mandate for the organiser.
  IF v_kind = 'declare_authority' THEN
    IF p_side <> 'shipper' THEN
      status := 'not_found';
      RETURN;
    END IF;
    v_holder := CASE p_command ->> 'holder'
                  WHEN 'self' THEN b.shipper_organisation_id
                  WHEN 'organiser' THEN (SELECT p.organiser_organisation_id FROM trucker.booking_party p WHERE p.booking_id = b.id)
                END;
    v_actions := ARRAY(SELECT DISTINCT e FROM jsonb_array_elements_text(coalesce(p_command -> 'actions', '[]'::jsonb)) e ORDER BY e);
    v_amount := trucker.cargo_amount(p_command ->> 'spendLimit', b.minor_units);
    v_text := nullif(btrim(coalesce(p_command ->> 'basisNote', '')), '');
    BEGIN
      v_until := (p_command ->> 'validUntil')::timestamptz;
    EXCEPTION WHEN others THEN
      v_problems := v_problems || jsonb_build_object('field', 'validUntil', 'code', 'invalid');
    END;
    IF v_holder IS NULL THEN
      v_problems := v_problems || jsonb_build_object('field', 'holder', 'code', 'invalid');
    END IF;
    -- The customer is the default holder only when it states that it holds the authority (section 3).
    IF p_command ->> 'holder' = 'self' AND (p_command ->> 'confirmContract') IS DISTINCT FROM 'true' THEN
      v_problems := v_problems || jsonb_build_object('field', 'confirmContract', 'code', 'required');
    END IF;
    IF cardinality(v_actions) = 0 OR NOT v_actions <@ trucker.instruction_actions() THEN
      v_problems := v_problems || jsonb_build_object('field', 'actions', 'code', 'invalid');
    END IF;
    IF v_amount IS NULL THEN
      v_problems := v_problems || jsonb_build_object('field', 'spendLimit', 'code', 'invalid');
    END IF;
    IF v_text IS NULL OR char_length(v_text) > 1000 THEN
      v_problems := v_problems || jsonb_build_object('field', 'basisNote', 'code', 'required');
    END IF;
    IF nullif(btrim(coalesce(p_command ->> 'alternateContact', '')), '') IS NULL OR char_length(p_command ->> 'alternateContact') > 300 THEN
      v_problems := v_problems || jsonb_build_object('field', 'alternateContact', 'code', 'required');
    END IF;
    IF v_until IS NOT NULL AND v_until <= p_at THEN
      v_problems := v_problems || jsonb_build_object('field', 'validUntil', 'code', 'passed');
    END IF;
    IF jsonb_array_length(v_problems) > 0 THEN
      status := 'invalid';
      detail := v_problems;
      RETURN;
    END IF;
    -- A new declaration replaces the one in force for that holder; the old one stays as history.
    UPDATE trucker.instruction_authority x SET ended_at = p_at, ended_by = p_actor, end_reason = 'replaced'
    WHERE x.booking_id = b.id AND x.holder_organisation_id = v_holder AND x.ended_at IS NULL;
    INSERT INTO trucker.instruction_authority (booking_id, holder_organisation_id, holder_role, basis, basis_note,
                                               actions, spend_limit, currency_code, valid_until, alternate_contact,
                                               declared_by, declared_at)
    VALUES (b.id, v_holder, CASE WHEN v_holder = b.shipper_organisation_id THEN 'contracting_customer' ELSE 'organiser' END,
            CASE WHEN v_holder = b.shipper_organisation_id THEN 'customer_declared_contract' ELSE 'customer_mandate' END,
            v_text, v_actions, v_amount, b.currency_code, v_until, btrim(p_command ->> 'alternateContact'), p_actor, p_at);
    PERFORM trucker.cargo_audit(p_at, p_actor, NULL, b, 'booking.instruction_authority_declared',
                                jsonb_build_object('holder', v_holder, 'actions', to_jsonb(v_actions)));
    status := 'declared';
    done := true;
    RETURN;
  END IF;

  IF v_kind = 'end_authority' THEN
    BEGIN
      SELECT * INTO a FROM trucker.instruction_authority x
      WHERE x.id = (p_command ->> 'authorityId')::uuid AND x.booking_id = b.id FOR UPDATE;
    EXCEPTION WHEN others THEN
      a := NULL;
    END;
    -- The customer ends any; the organiser only its own mandate.
    IF a.id IS NULL OR NOT (p_side = 'shipper' OR (p_side = 'organiser' AND a.holder_organisation_id = p_org)) THEN
      status := 'not_found';
      RETURN;
    END IF;
    v_note := nullif(btrim(coalesce(p_command ->> 'reason', '')), '');
    IF v_note IS NULL OR char_length(v_note) > 1000 THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'reason', 'code', 'required'));
      RETURN;
    END IF;
    IF a.ended_at IS NOT NULL THEN
      status := 'not_open';
      RETURN;
    END IF;
    UPDATE trucker.instruction_authority x SET ended_at = p_at, ended_by = p_actor, end_reason = v_note WHERE x.id = a.id;
    PERFORM trucker.cargo_audit(p_at, p_actor, NULL, b, 'booking.instruction_authority_ended', jsonb_build_object('authority', a.id));
    status := 'ended';
    done := true;
    RETURN;
  END IF;

  -- Everything else concerns a dispatched trip's case.
  IF tr.id IS NULL THEN
    status := 'not_dispatched';
    RETURN;
  END IF;

  IF k.id IS NULL THEN
    status := 'no_case';
    RETURN;
  END IF;
  IF k.closed_at IS NOT NULL AND v_kind NOT IN ('record_liability', 'decide_claim', 'release_hold') THEN
    status := 'case_closed';
    RETURN;
  END IF;

  -- The authorised party asks for an action (section 4).
  IF v_kind = 'issue' THEN
    IF p_side NOT IN ('shipper', 'organiser') THEN
      status := 'not_found';
      RETURN;
    END IF;
    IF NOT coalesce(p_command ->> 'action', '') = ANY (trucker.instruction_actions())
       OR ((p_command ->> 'action') IN ('alternate_destination', 'return_destination')
           AND nullif(btrim(coalesce(p_command ->> 'destination', '')), '') IS NULL)
       OR char_length(coalesce(p_command ->> 'destination', '')) > 500 OR char_length(coalesce(p_command ->> 'details', '')) > 2000 THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'action', 'code', 'invalid'));
      RETURN;
    END IF;
    a := trucker.instruction_authority_of(b.id, p_org, p_at);
    IF a.id IS NULL OR NOT (p_command ->> 'action') = ANY (a.actions) THEN
      status := 'no_authority';
      RETURN;
    END IF;
    IF k.authority_allowed_actions IS NOT NULL AND NOT (p_command ->> 'action') = ANY (k.authority_allowed_actions) THEN
      status := 'authority_order';
      RETURN;
    END IF;
    IF v_version IS DISTINCT FROM k.row_version THEN
      status := 'conflict';
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM trucker.cargo_instruction x WHERE x.case_id = k.id
               AND x.state IN ('requested', 'offered', 'approved', 'executing')) THEN
      status := 'instruction_open';
      RETURN;
    END IF;
    INSERT INTO trucker.cargo_instruction (case_id, action, destination, details, issued_by, issuer_organisation_id,
                                           authority_id, issued_at, state, terms_version_id)
    VALUES (k.id, p_command ->> 'action', nullif(btrim(coalesce(p_command ->> 'destination', '')), ''),
            nullif(btrim(coalesce(p_command ->> 'details', '')), ''), p_actor, p_org, a.id, p_at, 'requested', terms.id);
    UPDATE trucker.cargo_case x SET row_version = row_version + 1 WHERE x.id = k.id;
    PERFORM trucker.cargo_audit(p_at, p_actor, NULL, b, 'trip.cargo_instructed',
                                jsonb_build_object('case', k.id, 'action', p_command ->> 'action'));
    status := 'issued';
    done := true;
    RETURN;
  END IF;

  -- The carrier's emergency protective action, only after the response time with no answer
  -- (section 6). It replaces an instruction still waiting for an answer; never an approved one.
  IF v_kind = 'emergency' THEN
    IF p_side <> 'carrier' THEN
      status := 'not_found';
      RETURN;
    END IF;
    IF p_at < k.response_due_at THEN
      status := 'not_due';
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM trucker.cargo_instruction x WHERE x.case_id = k.id AND x.state IN ('approved', 'executing')) THEN
      status := 'instruction_open';
      RETURN;
    END IF;
    IF NOT coalesce(p_command ->> 'action', '') = ANY (terms.emergency_actions) THEN
      status := 'not_in_plan';
      RETURN;
    END IF;
    IF k.authority_allowed_actions IS NOT NULL AND NOT (p_command ->> 'action') = ANY (k.authority_allowed_actions) THEN
      status := 'authority_order';
      RETURN;
    END IF;
    v_costs := coalesce(p_command -> 'costs', '[]'::jsonb);
    SELECT x.status, x.detail, x.total INTO status, detail, v_total FROM trucker.cargo_cost_check(b, tr.id, terms, v_costs, p_at) x;
    IF status IS NOT NULL THEN
      RETURN;
    END IF;
    IF v_total > terms.emergency_cap OR b.currency_code <> terms.exception_rate_currency AND v_total > 0 THEN
      status := 'over_cap';
      RETURN;
    END IF;
    UPDATE trucker.cargo_instruction x SET state = 'withdrawn', row_version = row_version + 1,
      execution_note = 'Replaced by the carrier''s emergency protective action after no answer'
    WHERE x.case_id = k.id AND x.state IN ('requested', 'offered');
    INSERT INTO trucker.cargo_instruction (case_id, action, destination, details, issued_by, issuer_organisation_id,
                                           emergency, issued_at, state, feasible, offered_by, offered_at, decided_at,
                                           approval_basis, approved_total, terms_version_id)
    VALUES (k.id, p_command ->> 'action', nullif(btrim(coalesce(p_command ->> 'destination', '')), ''),
            nullif(btrim(coalesce(p_command ->> 'details', '')), ''), p_actor, p_org, true, p_at, 'approved', true,
            p_actor, p_at, p_at, 'emergency_plan', v_total, terms.id)
    RETURNING * INTO i;
    PERFORM trucker.cargo_cost_add(b, k, i, v_costs, p_actor, p_org, p_at, terms, 'carrier');
    UPDATE trucker.cargo_case x SET row_version = row_version + 1 WHERE x.id = k.id;
    PERFORM trucker.cargo_audit(p_at, p_actor, NULL, b, 'trip.cargo_emergency',
                                jsonb_build_object('case', k.id, 'action', i.action, 'total', v_total));
    status := 'emergency';
    done := true;
    RETURN;
  END IF;

  -- Commands on one instruction.
  IF v_kind IN ('withdraw', 'offer', 'decide', 'execute') THEN
    BEGIN
      SELECT * INTO i FROM trucker.cargo_instruction x
      WHERE x.id = (p_command ->> 'instructionId')::uuid AND x.case_id = k.id FOR UPDATE;
    EXCEPTION WHEN others THEN
      i := NULL;
    END;
    IF i.id IS NULL THEN
      status := 'not_found';
      RETURN;
    END IF;
    IF v_version IS DISTINCT FROM i.row_version THEN
      status := 'conflict';
      RETURN;
    END IF;
  END IF;

  IF v_kind = 'withdraw' THEN
    IF NOT (p_side IN ('shipper', 'organiser') AND i.issuer_organisation_id = p_org) THEN
      status := 'not_found';
      RETURN;
    END IF;
    IF i.state NOT IN ('requested', 'offered') THEN
      status := 'not_open';
      RETURN;
    END IF;
    UPDATE trucker.cargo_instruction x SET state = 'withdrawn', row_version = row_version + 1 WHERE x.id = i.id;
    status := 'withdrawn';
    done := true;
    RETURN;
  END IF;

  -- The carrier answers: feasible or not, when, and what it costs, item by item (section 5).
  IF v_kind = 'offer' THEN
    IF p_side <> 'carrier' THEN
      status := 'not_found';
      RETURN;
    END IF;
    IF i.state <> 'requested' THEN
      status := 'not_open';
      RETURN;
    END IF;
    IF (p_command ->> 'feasible') NOT IN ('true', 'false') THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'feasible', 'code', 'invalid'));
      RETURN;
    END IF;
    IF (p_command ->> 'feasible') = 'false' THEN
      UPDATE trucker.cargo_instruction x SET state = 'not_feasible', feasible = false, offered_by = p_actor, offered_at = p_at,
        offer_note = nullif(left(btrim(coalesce(p_command ->> 'note', '')), 2000), ''), row_version = row_version + 1
      WHERE x.id = i.id;
      status := 'offered';
      done := true;
      RETURN;
    END IF;
    v_costs := coalesce(p_command -> 'costs', '[]'::jsonb);
    SELECT x.status, x.detail, x.total INTO status, detail, v_total FROM trucker.cargo_cost_check(b, tr.id, terms, v_costs, p_at) x;
    IF status IS NOT NULL THEN
      RETURN;
    END IF;
    BEGIN
      UPDATE trucker.cargo_instruction x SET state = 'offered', feasible = true, offered_by = p_actor, offered_at = p_at,
        offer_eta = (p_command ->> 'eta')::timestamptz, offer_note = nullif(left(btrim(coalesce(p_command ->> 'note', '')), 2000), ''),
        row_version = row_version + 1
      WHERE x.id = i.id;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'eta', 'code', 'invalid'));
      RETURN;
    END;
    PERFORM trucker.cargo_cost_add(b, k, i, v_costs, p_actor, p_org, p_at, terms, 'not_set');
    PERFORM trucker.cargo_audit(p_at, p_actor, NULL, b, 'trip.cargo_offered',
                                jsonb_build_object('case', k.id, 'instruction', i.id, 'total', v_total));
    status := 'offered';
    done := true;
    RETURN;
  END IF;

  -- The authorised party approves or declines, within its limit, explicitly (sections 3 and 6).
  IF v_kind = 'decide' THEN
    IF p_side NOT IN ('shipper', 'organiser') THEN
      status := 'not_found';
      RETURN;
    END IF;
    a := trucker.instruction_authority_of(b.id, p_org, p_at);
    IF a.id IS NULL OR NOT i.action = ANY (a.actions) THEN
      status := 'no_authority';
      RETURN;
    END IF;
    IF i.state <> 'offered' THEN
      status := 'not_open';
      RETURN;
    END IF;
    IF (p_command ->> 'decision') NOT IN ('approve', 'decline')
       OR coalesce(p_command ->> 'interimPayer', 'instructing_party') NOT IN ('instructing_party', 'carrier') THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'decision', 'code', 'invalid'));
      RETURN;
    END IF;
    v_total := coalesce((SELECT sum(c.amount) FROM trucker.exception_cost c WHERE c.instruction_id = i.id), 0);
    IF p_command ->> 'decision' = 'approve' AND v_total > a.spend_limit THEN
      status := 'over_limit';
      detail := jsonb_build_object('total', trucker.amount_text(v_total, b.minor_units), 'limit', trucker.amount_text(a.spend_limit, b.minor_units));
      RETURN;
    END IF;
    UPDATE trucker.cargo_instruction x
    SET state = CASE WHEN p_command ->> 'decision' = 'approve' THEN 'approved' ELSE 'declined' END,
        decided_by = p_actor, decided_at = p_at,
        approval_basis = CASE WHEN p_command ->> 'decision' = 'approve' THEN 'authorised_party' END,
        approved_total = CASE WHEN p_command ->> 'decision' = 'approve' THEN v_total END,
        row_version = row_version + 1
    WHERE x.id = i.id;
    IF p_command ->> 'decision' = 'approve' THEN
      UPDATE trucker.exception_cost c SET interim_payer = coalesce(p_command ->> 'interimPayer', 'instructing_party')
      WHERE c.instruction_id = i.id;
    END IF;
    PERFORM trucker.cargo_audit(p_at, p_actor, NULL, b, 'trip.cargo_decided',
                                jsonb_build_object('case', k.id, 'instruction', i.id, 'decision', p_command ->> 'decision'));
    status := CASE WHEN p_command ->> 'decision' = 'approve' THEN 'approved' ELSE 'declined' END;
    done := true;
    RETURN;
  END IF;

  -- The carrier starts, completes or reports a failure. Starting a retry, a new destination or a
  -- return with cargo still on the vehicle opens a leg of this trip with the same resources.
  IF v_kind = 'execute' THEN
    IF p_side <> 'carrier' THEN
      status := 'not_found';
      RETURN;
    END IF;
    v_note := nullif(left(btrim(coalesce(p_command ->> 'note', '')), 2000), '');
    IF p_command ->> 'step' = 'start' THEN
      IF i.state <> 'approved' THEN
        status := 'not_open';
        RETURN;
      END IF;
      UPDATE trucker.cargo_instruction x SET state = 'executing', started_at = p_at, row_version = row_version + 1 WHERE x.id = i.id;
      IF i.action IN ('retry_delivery', 'alternate_destination', 'return_to_sender', 'return_destination')
         AND trucker.cargo_on_vehicle(tr.id) > 0 THEN
        INSERT INTO trucker.trip_leg (trip_id, instruction_id, kind, destination, created_at)
        VALUES (tr.id, i.id, i.action,
                coalesce(i.destination, CASE i.action WHEN 'retry_delivery' THEN 'The original delivery address'
                                                       ELSE 'The original pick-up address' END), p_at);
      END IF;
      status := 'started';
    ELSIF p_command ->> 'step' IN ('complete', 'fail') THEN
      IF i.state <> 'executing' THEN
        status := 'not_open';
        RETURN;
      END IF;
      IF p_command ->> 'step' = 'complete'
         AND EXISTS (SELECT 1 FROM trucker.trip_leg l WHERE l.instruction_id = i.id AND l.state <> 'completed') THEN
        status := 'leg_under_way';
        RETURN;
      END IF;
      IF p_command ->> 'step' = 'fail' AND v_note IS NULL THEN
        status := 'invalid';
        detail := jsonb_build_array(jsonb_build_object('field', 'note', 'code', 'required'));
        RETURN;
      END IF;
      UPDATE trucker.cargo_instruction x
      SET state = CASE WHEN p_command ->> 'step' = 'complete' THEN 'completed' ELSE 'failed' END,
          ended_at = p_at, execution_note = v_note, row_version = row_version + 1
      WHERE x.id = i.id;
      status := CASE WHEN p_command ->> 'step' = 'complete' THEN 'completed' ELSE 'failed' END;
    ELSE
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'step', 'code', 'invalid'));
      RETURN;
    END IF;
    PERFORM trucker.cargo_audit(p_at, p_actor, NULL, b, 'trip.cargo_executed',
                                jsonb_build_object('case', k.id, 'instruction', i.id, 'step', p_command ->> 'step'));
    done := true;
    RETURN;
  END IF;

  -- The receiving side confirms or rejects a handover; the carrier never confirms its own (section 7).
  IF v_kind = 'confirm_receipt' THEN
    IF p_side NOT IN ('shipper', 'organiser', 'operations')
       OR (p_side = 'organiser' AND trucker.instruction_authority_of(b.id, p_org, p_at) IS NULL) THEN
      status := 'not_found';
      RETURN;
    END IF;
    BEGIN
      v_id := (p_command ->> 'handoverId')::uuid;
    EXCEPTION WHEN others THEN
      v_id := NULL;
    END;
    IF NOT EXISTS (SELECT 1 FROM trucker.cargo_handover h WHERE h.id = v_id AND h.trip_id = tr.id) THEN
      status := 'not_found';
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM trucker.cargo_handover_receipt r WHERE r.handover_id = v_id) THEN
      status := 'not_open';
      RETURN;
    END IF;
    v_text := nullif(btrim(coalesce(p_command ->> 'reference', '')), '');
    IF (p_command ->> 'state') NOT IN ('confirmed', 'rejected') OR v_text IS NULL OR char_length(v_text) > 500 THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'reference', 'code', 'required'));
      RETURN;
    END IF;
    INSERT INTO trucker.cargo_handover_receipt (handover_id, state, reference, confirmed_by, confirmed_by_staff, confirmed_at)
    VALUES (v_id, p_command ->> 'state', v_text, p_actor, p_staff, p_at);
    PERFORM trucker.cargo_audit(p_at, p_actor, p_staff, b, 'trip.cargo_receipt',
                                jsonb_build_object('handover', v_id, 'state', p_command ->> 'state'));
    status := p_command ->> 'state';
    done := true;
    RETURN;
  END IF;

  -- The driver or the carrier records a leg's progress, and its own delivery (section 8).
  IF v_kind = 'leg' THEN
    IF p_side NOT IN ('carrier', 'driver') THEN
      status := 'not_found';
      RETURN;
    END IF;
    BEGIN
      SELECT * INTO v_leg FROM trucker.trip_leg l WHERE l.id = (p_command ->> 'legId')::uuid AND l.trip_id = tr.id FOR UPDATE;
    EXCEPTION WHEN others THEN
      v_leg := NULL;
    END;
    IF v_leg.id IS NULL THEN
      status := 'not_found';
      RETURN;
    END IF;
    IF (p_command ->> 'step') IS DISTINCT FROM (CASE v_leg.state WHEN 'planned' THEN 'departed' WHEN 'departed' THEN 'arrived'
                                                                  WHEN 'arrived' THEN 'completed' END) THEN
      status := 'not_open';
      RETURN;
    END IF;
    IF p_command ->> 'step' = 'completed' THEN
      v_amount := (SELECT CASE WHEN (p_command ->> 'quantityDelivered') ~ '^[0-9]{1,9}(\.[0-9]{1,3})?$'
                               THEN (p_command ->> 'quantityDelivered')::numeric END);
      IF v_amount IS NULL OR v_amount > trucker.cargo_on_vehicle(tr.id)
         OR (v_amount > 0 AND nullif(btrim(coalesce(p_command ->> 'receiverName', '')), '') IS NULL) THEN
        status := 'invalid';
        detail := jsonb_build_array(jsonb_build_object('field', 'quantityDelivered', 'code', 'invalid'));
        RETURN;
      END IF;
      UPDATE trucker.trip_leg l SET state = 'completed', completed_at = p_at, quantity_delivered = v_amount,
        receiver_name = nullif(left(btrim(coalesce(p_command ->> 'receiverName', '')), 200), ''),
        completion_note = nullif(left(btrim(coalesce(p_command ->> 'note', '')), 1000), ''), recorded_by = p_actor
      WHERE l.id = v_leg.id;
    ELSE
      UPDATE trucker.trip_leg l SET state = p_command ->> 'step',
        departed_at = CASE WHEN p_command ->> 'step' = 'departed' THEN p_at ELSE departed_at END,
        arrived_at = CASE WHEN p_command ->> 'step' = 'arrived' THEN p_at ELSE arrived_at END
      WHERE l.id = v_leg.id;
    END IF;
    PERFORM trucker.cargo_audit(p_at, p_actor, NULL, b, 'trip.leg_progressed',
                                jsonb_build_object('leg', v_leg.id, 'step', p_command ->> 'step'));
    status := 'leg_updated';
    done := true;
    RETURN;
  END IF;

  -- A disputed cost, or a claim of carrier fault: each places its own hold, on those costs only
  -- (section 9). Nothing is deducted and no money moves.
  IF v_kind IN ('dispute_cost', 'raise_claim') THEN
    IF NOT (p_side = 'shipper' OR (p_side = 'organiser' AND trucker.instruction_authority_of(b.id, p_org, p_at) IS NOT NULL)) THEN
      status := 'not_found';
      RETURN;
    END IF;
    BEGIN
      v_ids := ARRAY(SELECT DISTINCT e::uuid FROM jsonb_array_elements_text(coalesce(p_command -> 'costIds', '[]'::jsonb)) e);
    EXCEPTION WHEN others THEN
      v_ids := ARRAY[]::uuid[];
    END;
    v_text := nullif(btrim(coalesce(p_command ->> 'reason', '')), '');
    IF cardinality(v_ids) = 0
       OR (SELECT count(*) FROM trucker.exception_cost c WHERE c.id = ANY (v_ids) AND c.case_id = k.id) <> cardinality(v_ids)
       OR v_text IS NULL OR char_length(v_text) > 1000 THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', CASE WHEN v_text IS NULL THEN 'reason' ELSE 'costIds' END,
                                                     'code', 'invalid'));
      RETURN;
    END IF;
    IF v_kind = 'raise_claim' THEN
      INSERT INTO trucker.carrier_claim (case_id, raised_by, raised_by_organisation_id, raised_at, description, cost_ids)
      VALUES (k.id, p_actor, p_org, p_at, v_text, v_ids) RETURNING * INTO v_claim;
      v_id := v_claim.id;
    ELSE
      v_id := gen_random_uuid();
    END IF;
    INSERT INTO trucker.settlement_hold (booking_id, owner_kind, owner_id, cost_ids, reason, placed_by, placed_at)
    VALUES (b.id, CASE WHEN v_kind = 'raise_claim' THEN 'carrier_claim' ELSE 'cost_dispute' END, v_id, v_ids, v_text, p_actor, p_at);
    PERFORM trucker.cargo_audit(p_at, p_actor, NULL, b, 'booking.hold_placed',
                                jsonb_build_object('case', k.id, 'kind', v_kind, 'costs', to_jsonb(v_ids)));
    status := CASE WHEN v_kind = 'raise_claim' THEN 'claimed' ELSE 'disputed' END;
    done := true;
    RETURN;
  END IF;

  -- Operations: a competent authority's instruction, which limits what may be instructed.
  IF v_kind = 'authority_order' AND p_side = 'operations' THEN
    v_text := nullif(btrim(coalesce(p_command ->> 'order', '')), '');
    v_actions := ARRAY(SELECT DISTINCT e FROM jsonb_array_elements_text(coalesce(p_command -> 'allowedActions', '[]'::jsonb)) e ORDER BY e);
    IF v_text IS NULL OR char_length(v_text) > 2000 OR NOT v_actions <@ trucker.instruction_actions() THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'order', 'code', 'invalid'));
      RETURN;
    END IF;
    IF k.authority_order IS NOT NULL THEN
      status := 'not_open';
      RETURN;
    END IF;
    UPDATE trucker.cargo_case x SET authority_order = v_text, authority_allowed_actions = v_actions,
      row_version = row_version + 1 WHERE x.id = k.id;
    -- An open instruction outside what the authority allows stops.
    UPDATE trucker.cargo_instruction x SET state = 'withdrawn', row_version = row_version + 1,
      execution_note = 'Stopped by the instruction of a competent authority'
    WHERE x.case_id = k.id AND x.state IN ('requested', 'offered', 'approved') AND NOT x.action = ANY (v_actions);
    PERFORM trucker.cargo_audit(p_at, NULL, p_staff, b, 'trip.cargo_authority_order', jsonb_build_object('case', k.id));
    status := 'recorded';
    done := true;
    RETURN;
  END IF;

  IF v_kind = 'close_case' AND p_side = 'operations' THEN
    v_note := nullif(btrim(coalesce(p_command ->> 'note', '')), '');
    IF v_note IS NULL OR char_length(v_note) > 1000 THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'note', 'code', 'required'));
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM trucker.cargo_instruction x WHERE x.case_id = k.id AND x.state IN ('requested', 'offered', 'approved', 'executing')) THEN
      status := 'instruction_open';
      RETURN;
    END IF;
    -- Closing the case releases nothing: its holds and claims each end by their own decision.
    UPDATE trucker.cargo_case x SET closed_at = p_at, closed_by = p_staff, close_note = v_note, row_version = row_version + 1
    WHERE x.id = k.id;
    PERFORM trucker.cargo_audit(p_at, NULL, p_staff, b, 'trip.cargo_case_closed', jsonb_build_object('case', k.id));
    status := 'closed';
    done := true;
    RETURN;
  END IF;

  -- Operations records who finally bears a cost, from a contract, a settlement or a competent
  -- decision, with its reference. Trucker does not decide it alone.
  IF v_kind = 'record_liability' AND p_side = 'operations' THEN
    v_liability := p_command ->> 'liability';
    v_text := nullif(btrim(coalesce(p_command ->> 'reference', '')), '');
    IF v_liability NOT IN ('contracting_customer', 'organiser', 'carrier', 'shared', 'other')
       OR (p_command ->> 'source') NOT IN ('contract', 'settlement', 'competent_decision')
       OR v_text IS NULL OR char_length(v_text) > 500 THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'liability', 'code', 'invalid'));
      RETURN;
    END IF;
    BEGIN
      v_id := (p_command ->> 'costId')::uuid;
    EXCEPTION WHEN others THEN
      v_id := NULL;
    END;
    IF NOT EXISTS (SELECT 1 FROM trucker.exception_cost c WHERE c.id = v_id AND c.case_id = k.id AND c.final_liability IS NULL) THEN
      status := 'not_open';
      RETURN;
    END IF;
    UPDATE trucker.exception_cost c SET final_liability = v_liability, final_source = p_command ->> 'source',
      final_reference = v_text, final_recorded_by = p_staff, final_recorded_at = p_at
    WHERE c.id = v_id;
    PERFORM trucker.cargo_audit(p_at, NULL, p_staff, b, 'trip.cargo_liability_recorded',
                                jsonb_build_object('cost', v_id, 'liability', v_liability, 'source', p_command ->> 'source'));
    status := 'recorded';
    done := true;
    RETURN;
  END IF;

  IF v_kind = 'decide_claim' AND p_side = 'operations' THEN
    BEGIN
      SELECT * INTO v_claim FROM trucker.carrier_claim c WHERE c.id = (p_command ->> 'claimId')::uuid AND c.case_id = k.id FOR UPDATE;
    EXCEPTION WHEN others THEN
      v_claim := NULL;
    END;
    v_text := nullif(btrim(coalesce(p_command ->> 'reference', '')), '');
    IF v_claim.id IS NULL THEN
      status := 'not_found';
      RETURN;
    END IF;
    IF v_claim.state <> 'open' THEN
      status := 'not_open';
      RETURN;
    END IF;
    IF (p_command ->> 'decision') NOT IN ('upheld', 'partly_upheld', 'rejected')
       OR (p_command ->> 'source') NOT IN ('contract', 'settlement', 'competent_decision')
       OR v_text IS NULL OR char_length(v_text) > 500 THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'decision', 'code', 'invalid'));
      RETURN;
    END IF;
    UPDATE trucker.carrier_claim c SET state = 'decided', decision = p_command ->> 'decision',
      decision_source = p_command ->> 'source', decision_reference = v_text, decided_by = p_staff, decided_at = p_at
    WHERE c.id = v_claim.id;
    PERFORM trucker.cargo_audit(p_at, NULL, p_staff, b, 'trip.cargo_claim_decided',
                                jsonb_build_object('claim', v_claim.id, 'decision', p_command ->> 'decision'));
    status := 'decided';
    done := true;
    RETURN;
  END IF;

  -- A hold is released only by its owner: a decided claim, or a cost dispute whose costs all have
  -- their final liability recorded. Another case or claim never releases it (DI-401).
  IF v_kind = 'release_hold' AND p_side = 'operations' THEN
    BEGIN
      SELECT * INTO v_hold FROM trucker.settlement_hold h WHERE h.id = (p_command ->> 'holdId')::uuid AND h.booking_id = b.id FOR UPDATE;
    EXCEPTION WHEN others THEN
      v_hold := NULL;
    END;
    v_note := nullif(btrim(coalesce(p_command ->> 'note', '')), '');
    IF v_hold.id IS NULL THEN
      status := 'not_found';
      RETURN;
    END IF;
    IF v_note IS NULL OR char_length(v_note) > 1000 THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'note', 'code', 'required'));
      RETURN;
    END IF;
    IF v_hold.released_at IS NOT NULL THEN
      status := 'not_open';
      RETURN;
    END IF;
    IF (v_hold.owner_kind = 'carrier_claim'
        AND NOT EXISTS (SELECT 1 FROM trucker.carrier_claim c WHERE c.id = v_hold.owner_id AND c.state <> 'open'))
       OR (v_hold.owner_kind = 'cost_dispute'
           AND EXISTS (SELECT 1 FROM trucker.exception_cost c WHERE c.id = ANY (v_hold.cost_ids) AND c.final_liability IS NULL)) THEN
      status := 'owner_open';
      RETURN;
    END IF;
    UPDATE trucker.settlement_hold h SET released_at = p_at, released_by = p_staff, release_note = v_note WHERE h.id = v_hold.id;
    PERFORM trucker.cargo_audit(p_at, NULL, p_staff, b, 'booking.hold_released', jsonb_build_object('hold', v_hold.id));
    status := 'released';
    done := true;
    RETURN;
  END IF;

  status := 'invalid';
  detail := jsonb_build_array(jsonb_build_object('field', 'command', 'code', 'invalid'));
END
$$;

-- Checks cost lines: kind, unit, quantity and unit amount within the booking's decimals; waiting no
-- more than the billable waiting; a return fee only where the booking's terms allow it to be offered.
-- Returns status NULL and the total when they are acceptable.
CREATE FUNCTION trucker.cargo_cost_check(b trucker.booking, p_trip uuid, terms trucker.financial_setting_version,
                                         p_costs jsonb, p_at timestamptz,
                                         OUT status text, OUT detail jsonb, OUT total numeric)
RETURNS record
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  c jsonb;
  q numeric;
  u numeric;
  n integer := 0;
  v_waiting numeric := 0;
BEGIN
  total := 0;
  IF jsonb_typeof(p_costs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_costs) > 20 THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'costs', 'code', 'invalid'));
    RETURN;
  END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(p_costs) LOOP
    n := n + 1;
    q := CASE WHEN (c ->> 'quantity') ~ '^[0-9]{1,6}(\.[0-9]{1,3})?$' THEN (c ->> 'quantity')::numeric END;
    u := trucker.cargo_amount(c ->> 'unitAmount', b.minor_units);
    IF NOT coalesce(c ->> 'kind', '') = ANY (ARRAY['waiting', 'handling', 'unloading', 'storage', 'retry',
                                                    'alternate_transport', 'return', 'other'])
       OR NOT coalesce(c ->> 'unit', '') = ANY (ARRAY['hour', 'day', 'trip', 'item', 'lump_sum'])
       OR q IS NULL OR q <= 0 OR u IS NULL
       OR (c ->> 'kind' = 'other' AND nullif(btrim(coalesce(c ->> 'description', '')), '') IS NULL)
       OR char_length(coalesce(c ->> 'description', '')) > 500 THEN
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'costs[' || (n - 1) || ']', 'code', 'invalid'));
      RETURN;
    END IF;
    IF c ->> 'kind' = 'waiting' THEN
      IF c ->> 'unit' <> 'hour' THEN
        status := 'invalid';
        detail := jsonb_build_array(jsonb_build_object('field', 'costs[' || (n - 1) || ']', 'code', 'invalid'));
        RETURN;
      END IF;
      v_waiting := v_waiting + q;
    END IF;
    IF c ->> 'kind' = 'return' AND terms.return_trip_fee <> 'carrier_offer' THEN
      status := 'return_fee_not_allowed';
      RETURN;
    END IF;
    total := total + round(q * u, b.minor_units);
  END LOOP;
  -- Waiting stops when the truck is released (section 7): no more than what was billable.
  v_waiting := v_waiting + coalesce((SELECT sum(x.quantity) FROM trucker.exception_cost x
                                      JOIN trucker.cargo_instruction i ON i.id = x.instruction_id
                                      JOIN trucker.cargo_case k ON k.id = x.case_id
                                      WHERE k.trip_id = p_trip AND x.kind = 'waiting'
                                        AND i.state NOT IN ('declined', 'withdrawn', 'not_feasible')), 0);
  IF v_waiting > 0 AND v_waiting * 60 > coalesce(trucker.billable_waiting_minutes(b, p_trip, p_at), 0) THEN
    status := 'exceeds_waiting';
    RETURN;
  END IF;
END
$$;

-- Records cost lines with exact amounts. No fee, commission or margin is added (section 5).
CREATE FUNCTION trucker.cargo_cost_add(b trucker.booking, k trucker.cargo_case, i trucker.cargo_instruction, p_costs jsonb,
                                       p_actor uuid, p_org uuid, p_at timestamptz, terms trucker.financial_setting_version,
                                       p_interim text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.exception_cost (case_id, instruction_id, line_no, kind, description, quantity, unit, unit_amount, amount,
                                      currency_code, offered_by, offered_by_organisation_id, offered_at, terms_version_id,
                                      interim_payer, provisional_liability)
  SELECT k.id, i.id, n::integer, c ->> 'kind', nullif(btrim(coalesce(c ->> 'description', '')), ''), (c ->> 'quantity')::numeric,
         c ->> 'unit', (c ->> 'unitAmount')::numeric, round((c ->> 'quantity')::numeric * (c ->> 'unitAmount')::numeric, b.minor_units),
         b.currency_code, p_actor, p_org, p_at, terms.id, p_interim,
         -- A cause on the customer's side (address, absence, site): borne as the contract says. Anything
         -- else, including a refusal or a claim against the carrier: pending. Never the receiver.
         CASE WHEN (SELECT f.reason FROM trucker.delivery_shortfall f JOIN trucker.trip_delivery_outcome o ON o.id = f.outcome_id
                    WHERE o.trip_id = k.trip_id ORDER BY o.version DESC LIMIT 1)
                   IN ('wrong_address', 'receiver_absent', 'site_not_ready', 'site_closed')
              THEN 'per_contract' ELSE 'pending' END
  FROM jsonb_array_elements(p_costs) WITH ORDINALITY AS e(c, n)
$$;

-- The organiser's view: the cases where it holds, or held, an authority, and nothing else of the
-- booking (section 3; test 13).
CREATE FUNCTION trucker.organiser_cargo_cases(OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF org IS NULL OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  status := 'ok';
  detail := coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'bookingId', b.id,
             'shipper', (SELECT o.legal_name FROM trucker.organisation o WHERE o.id = b.shipper_organisation_id),
             'delivery', b.shipment_snapshot #>> '{delivery,area}',
             'currency', b.currency_code,
             'cargo', trucker.cargo_values(t.id, 'organiser'))
           ORDER BY b.accepted_at DESC)
    FROM trucker.booking b JOIN trucker.trip t ON t.booking_id = b.id
    WHERE EXISTS (SELECT 1 FROM trucker.instruction_authority a WHERE a.booking_id = b.id AND a.holder_organisation_id = org)
      AND org = (SELECT p.organiser_organisation_id FROM trucker.booking_party p WHERE p.booking_id = b.id)), '[]'::jsonb);
END
$$;

-- The authorities of a booking, before dispatch too, for its customer and carrier.
CREATE FUNCTION trucker.booking_authorities(p_booking uuid, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  v_side text;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  v_side := CASE WHEN b.id IS NULL THEN NULL ELSE trucker.cargo_side(b, org, actor) END;
  IF v_side IS NULL OR v_side = 'driver' THEN
    status := 'not_found';
    RETURN;
  END IF;
  status := 'ok';
  detail := jsonb_build_object(
    'organiser', (SELECT o.legal_name FROM trucker.booking_party p JOIN trucker.organisation o ON o.id = p.organiser_organisation_id
                  WHERE p.booking_id = b.id),
    'currency', b.currency_code,
    'authorities', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', a.id, 'holderRole', a.holder_role, 'basis', a.basis, 'basisNote', a.basis_note,
               'actions', to_jsonb(a.actions), 'spendLimit', trucker.amount_text(a.spend_limit, b.minor_units), 'validUntil', a.valid_until,
               'alternateContact', CASE WHEN v_side <> 'carrier' THEN a.alternate_contact END,
               'declaredAt', a.declared_at, 'endedAt', a.ended_at, 'endReason', a.end_reason)
             ORDER BY a.declared_at)
      FROM trucker.instruction_authority a
      WHERE a.booking_id = b.id AND (v_side <> 'organiser' OR a.holder_organisation_id = org)), '[]'::jsonb));
END
$$;

CREATE OR REPLACE FUNCTION trucker.staff_operations_queue(p_token_hash text, p_request_id text, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  e record;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.queue', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  PERFORM trucker.overrun_note(e.at);
  detail := jsonb_build_object(
    'open', coalesce((SELECT jsonb_agg(trucker.trip_case_values(c, 'operations') ORDER BY c.reported_at, c.id)
                      FROM trucker.trip_case c WHERE c.state <> 'resolved'), '[]'::jsonb),
    'resolved', coalesce((SELECT jsonb_agg(v ORDER BY (v ->> 'reportedAt') DESC)
                          FROM (SELECT trucker.trip_case_values(c, 'operations') AS v FROM trucker.trip_case c
                                WHERE c.state = 'resolved' ORDER BY c.reported_at DESC LIMIT 50) x), '[]'::jsonb),
    'blocks', coalesce((SELECT jsonb_agg(jsonb_build_object('bookingId', k.booking_id, 'reason', k.reason,
                                                            'blockedAt', k.blocked_at) ORDER BY k.blocked_at)
                        FROM trucker.dispatch_block k WHERE k.lifted_at IS NULL), '[]'::jsonb),
    -- Undeliverable cargo (R-406): open cases, overdue or escalated first, with what is still on the
    -- vehicle and the costs held in dispute.
    'cargo', coalesce((SELECT jsonb_agg(jsonb_build_object(
                         'bookingId', k.booking_id, 'caseId', k.id, 'cargoClass', k.cargo_class, 'openedAt', k.opened_at,
                         'responseDueAt', k.response_due_at, 'overdue', k.response_due_at <= e.at,
                         'escalatedAt', k.escalated_at, 'onVehicle', trucker.cargo_on_vehicle(k.trip_id),
                         'openInstruction', (SELECT i.state FROM trucker.cargo_instruction i WHERE i.case_id = k.id
                                             AND i.state IN ('requested', 'offered', 'approved', 'executing')),
                         'heldCosts', (SELECT count(*) FROM trucker.settlement_hold h
                                       WHERE h.booking_id = k.booking_id AND h.released_at IS NULL))
                       ORDER BY k.escalated_at IS NULL, k.response_due_at)
                       FROM trucker.cargo_case k WHERE k.closed_at IS NULL), '[]'::jsonb),
    'holds', coalesce((SELECT jsonb_agg(jsonb_build_object('bookingId', t.booking_id, 'reason', h.reason,
                                                           'heldAt', h.held_at) ORDER BY h.held_at)
                       FROM trucker.trip_hold h JOIN trucker.trip t ON t.id = h.trip_id
                       WHERE h.resumed_at IS NULL), '[]'::jsonb));
  PERFORM trucker.staff_audit(e.at, e.staff_id, 'staff.operations.queue', 'done', NULL, p_request_id, '{}'::jsonb);
END
$function$;


REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.cargo_command(uuid, text, jsonb) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_cargo_command(text, uuid, text, jsonb, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.organiser_cargo_cases() TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.booking_authorities(uuid) TO trucker_app;

CREATE OR REPLACE FUNCTION trucker.delivery_values(p_trip uuid, p_audience text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  WITH o AS (
    SELECT x AS rec, x.id, x.version, x.cargo_remains, row_number() OVER (ORDER BY x.version DESC) AS n
    FROM trucker.trip_delivery_outcome x WHERE x.trip_id = p_trip)
  SELECT jsonb_build_object(
    'outcome', (SELECT trucker.delivery_outcome_values(o.rec, p_audience) FROM o WHERE o.n = 1),
    'earlier', coalesce((SELECT jsonb_agg(trucker.delivery_outcome_values(o.rec, p_audience) ORDER BY o.version DESC)
                         FROM o WHERE o.n > 1), '[]'::jsonb),
    -- Custody is open while cargo is on the vehicle: a handover counts once its receipt is confirmed.
    'custody', (SELECT jsonb_build_object(
                  'open', trucker.cargo_on_vehicle(p_trip) > 0,
                  'handover', (SELECT jsonb_build_object(
                    'kind', h.kind, 'handedBy', h.handed_by, 'receivedBy', h.received_by, 'handedAt', h.handed_at,
                    'place', h.place, 'recordedAt', h.recorded_at,
                    'enteredAs', CASE WHEN h.recorded_by_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END,
                    'receipt', (SELECT r.state FROM trucker.cargo_handover_receipt r WHERE r.handover_id = h.id),
                    'note', CASE WHEN p_audience IN ('carrier', 'operations') THEN h.note END)
                    FROM trucker.cargo_handover h WHERE h.outcome_id = o.id ORDER BY h.recorded_at DESC, h.id LIMIT 1))
                FROM o WHERE o.n = 1 AND o.cargo_remains),
    'releases', CASE WHEN p_audience = 'shipper' THEN NULL ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'role', r.role, 'releasedAt', r.released_at, 'basis', r.basis,
               'releasedAs', CASE WHEN r.released_by_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END,
               'releasedBy', CASE WHEN r.released_by IS NOT NULL
                                  THEN (SELECT p.display_name FROM trucker.person p WHERE p.id = r.released_by)
                                  WHEN p_audience = 'operations'
                                  THEN (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = r.released_by_staff) END,
               'note', CASE WHEN p_audience = 'operations' THEN r.note END)
             ORDER BY r.released_at, r.role)
      FROM trucker.resource_release r JOIN trucker.trip t ON t.booking_id = r.booking_id
      WHERE t.id = p_trip), '[]'::jsonb) END)
$function$;

CREATE OR REPLACE FUNCTION trucker.booking_consistency()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'booking', x.booking, 'record', x.record)
                            ORDER BY x.code, x.booking, x.record), '[]'::jsonb)
  FROM (
    -- A confirmed booking without an active member for a role it requires.
    SELECT 'confirmed_missing_member' AS code, c.booking_id AS booking, c.booking_id AS record
    FROM trucker.booking_confirmation c
    WHERE NOT EXISTS (SELECT 1 FROM trucker.booking_cancellation z WHERE z.booking_id=c.booking_id) AND (NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a
                      WHERE a.booking_id = c.booking_id AND a.role = 'truck' AND a.status = 'active')
       OR NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a
                      WHERE a.booking_id = c.booking_id AND a.role = 'driver' AND a.status = 'active')
       OR (EXISTS (SELECT 1 FROM trucker.booking_assignment a
                   JOIN trucker.vehicle v ON v.id = a.vehicle_id
                   JOIN trucker.vehicle_category k ON k.code = v.category_code
                   WHERE a.booking_id = c.booking_id AND a.role = 'truck' AND a.status = 'active' AND k.requires_trailer)
           AND NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a
                           WHERE a.booking_id = c.booking_id AND a.role = 'trailer' AND a.status = 'active')))
    UNION ALL
    -- An active member whose reservation is not an active one for that booking and resource.
    SELECT 'member_without_reservation', a.booking_id, a.id
    FROM trucker.booking_assignment a
    LEFT JOIN trucker.resource_reservation r ON r.id = a.reservation_id
    WHERE a.status = 'active'
      AND (r.status IS DISTINCT FROM 'active' OR r.purpose <> 'assignment' OR r.booking_id <> a.booking_id
           OR r.resource_id <> coalesce(a.vehicle_id, a.person_id))
      -- Released from its trip by a recorded release (slice 18a).
      AND NOT (r.status = 'released' AND r.release_reason = 'trip_released'
               AND EXISTS (SELECT 1 FROM trucker.resource_release x WHERE x.reservation_id = r.id))
    UNION ALL
    -- An active reservation held for a set that no active member answers for.
    SELECT 'reservation_without_member', r.booking_id, r.id
    FROM trucker.resource_reservation r
    WHERE r.status = 'active' AND r.purpose = 'assignment'
      AND NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a WHERE a.reservation_id = r.id AND a.status = 'active')
    UNION ALL
    -- A reservation held for a proposal that is no longer open.
    SELECT 'proposed_reservation_without_proposal', r.booking_id, r.id
    FROM trucker.resource_reservation r
    WHERE r.status = 'active' AND r.purpose = 'proposed_substitute'
      AND NOT EXISTS (SELECT 1 FROM trucker.booking_substitution s WHERE s.id = r.substitution_id AND s.status = 'proposed')
    UNION ALL
    -- A resource physically committed with no active reservation behind it.
    SELECT 'occupancy_without_reservation', e.booking_id, e.id
    FROM trucker.occupancy_episode e
    JOIN trucker.resource_reservation r ON r.id = e.reservation_id
    WHERE e.closed_at IS NULL AND r.status <> 'active'
    UNION ALL
    SELECT 'cancelled_active_reservation', c.booking_id, r.id
    FROM trucker.booking_cancellation c JOIN trucker.resource_reservation r ON r.booking_id=c.booking_id
    WHERE r.status='active'
    UNION ALL
    SELECT 'cancelled_active_assignment', c.booking_id, a.id
    FROM trucker.booking_cancellation c JOIN trucker.booking_assignment a ON a.booking_id=c.booking_id
    WHERE a.status='active'
    UNION ALL
    -- A confirmation without the fee (R-14).
    SELECT 'confirmed_without_fee', c.booking_id, c.booking_id
    FROM trucker.booking_confirmation c WHERE NOT trucker.fee_settled(c.booking_id)
    UNION ALL
    -- A dispatched booking whose assigned resource has no open episode for it, and no release.
    SELECT 'trip_resource_not_occupied', t.booking_id, a.id
    FROM trucker.trip t JOIN trucker.booking_assignment a ON a.booking_id = t.booking_id AND a.status = 'active'
    WHERE NOT EXISTS (SELECT 1 FROM trucker.occupancy_episode e
                      WHERE e.booking_id = t.booking_id AND e.reservation_id = a.reservation_id AND e.closed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM trucker.resource_release x WHERE x.reservation_id = a.reservation_id)
    UNION ALL
    -- A release whose episode or reservation was not closed with it (slice 18a).
    SELECT 'release_not_applied', x.booking_id, x.id
    FROM trucker.resource_release x
    JOIN trucker.occupancy_episode e ON e.id = x.episode_id
    JOIN trucker.resource_reservation r ON r.id = x.reservation_id
    WHERE e.closed_at IS DISTINCT FROM x.released_at
       OR (r.status <> 'released' AND EXISTS (SELECT 1 FROM trucker.trip t WHERE t.booking_id = x.booking_id))
    UNION ALL
    -- A released resource whose outcome did not allow it and that operations did not release.
    SELECT 'released_with_custody_open', x.booking_id, x.id
    FROM trucker.resource_release x
    JOIN trucker.trip t ON t.booking_id = x.booking_id
    JOIN LATERAL (SELECT o.* FROM trucker.trip_delivery_outcome o WHERE o.trip_id = t.id
                  ORDER BY o.version DESC LIMIT 1) o ON true
    -- Slice 18d: custody is open while cargo is on the vehicle (confirmed handovers and completed legs count).
    WHERE x.basis = 'condition' AND o.cargo_remains AND trucker.cargo_on_vehicle(t.id) > 0
    UNION ALL
    -- A release of a resource while a leg of its trip is still under way (slice 18d).
    SELECT 'released_with_leg_under_way', x.booking_id, x.id
    FROM trucker.resource_release x JOIN trucker.trip t ON t.booking_id = x.booking_id
    WHERE EXISTS (SELECT 1 FROM trucker.trip_leg l WHERE l.trip_id = t.id AND l.state <> 'completed'
                  AND l.created_at < x.released_at)
    UNION ALL
    SELECT 'dispatched_and_cancelled', t.booking_id, t.id
    FROM trucker.trip t JOIN trucker.booking_cancellation c ON c.booking_id = t.booking_id
    UNION ALL
    SELECT 'cancelled_open_substitution', c.booking_id, s.id
    FROM trucker.booking_cancellation c JOIN trucker.booking_substitution s ON s.booking_id=c.booking_id
    WHERE s.status='proposed'
  ) AS x
$function$;
