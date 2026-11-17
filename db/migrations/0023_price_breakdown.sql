-- 0023_price_breakdown
-- Price breakdown, views by role, fee payer and freight terms (slice 25; model:
-- docs/specs/ADR_001_COMMERCIAL_MODEL.md, R-18, R-26, G-5, G-6, D-5, D-9, D-11).
--
-- Freight (R-26). A quotation states the freight payment methods the carrier accepts: cash on
-- delivery, bank transfer, or the carrier's own card gateway; for a transfer or the gateway, the
-- days after proof of delivery within which the freight is due, at most the freight due days of
-- the financial settings in force (D-9). The customer chooses one method when it accepts; the
-- booking fixes the method and the due rule. Trucker never receives the freight (G-12). No card
-- gateway can be activated yet, so that method is refused until activation exists.
--
-- Fee payer (D-5). Trucker's fee is paid by the shipment's fee payer: the contracting customer,
-- or the organiser where it agreed to pay. The fee payer setting in security_setting is removed.
--
-- Breakdown (G-5). Each booking has one price record, written once when the booking is made:
-- shipping price, commission option and its inputs, commission, carrier net, Trucker's fee and
-- its basis, each payer, currency, minor units, rounding, the freight terms and the settings
-- version. The database refuses a record whose parts do not add up exactly. Bookings made
-- before this migration get one too, marked as such, with the figures they were made with.
--
-- Views by role (G-6, D-11). The figures a booking shows are chosen by the database for the
-- one asking: the customer sees the shipping price, the fee and its total; the carrier the
-- shipping price, the commission and its net (the fee only if it pays it); the organiser the
-- shipping price, the commission and the net, and the fee if it pays it; staff everything.

-- ---------------------------------------------------------------------------------------------
-- Freight terms on quotations
-- ---------------------------------------------------------------------------------------------
-- Quotations made before this migration offered no method: they are taken to offer bank
-- transfer within the freight due days then in force (the earlier model's payment term).
DO $$
DECLARE
  v_days integer := (trucker.financial_settings_at(now())).freight_due_days;
BEGIN
  EXECUTE 'ALTER TABLE trucker.quotation_version'
       || ' ADD COLUMN freight_methods text[] NOT NULL DEFAULT ARRAY[''bank_transfer'']::text[],'
       || ' ADD COLUMN freight_due_days integer DEFAULT ' || v_days;
END
$$;
ALTER TABLE trucker.quotation_version
  ALTER COLUMN freight_methods DROP DEFAULT,
  ALTER COLUMN freight_due_days DROP DEFAULT,
  ADD CONSTRAINT quotation_version_freight CHECK (
    cardinality(freight_methods) BETWEEN 1 AND 3
    AND freight_methods <@ ARRAY['cash_on_delivery', 'bank_transfer', 'card_gateway']::text[]
    AND array_position(freight_methods, NULL) IS NULL
    AND (freight_methods && ARRAY['bank_transfer', 'card_gateway']::text[]) = (freight_due_days IS NOT NULL)
    AND (freight_due_days IS NULL OR freight_due_days BETWEEN 0 AND 365));

-- The freight terms of a quotation, or the problems with them.
--   p_content -> 'freight': {"methods": [text], "dueDays": int | null}
-- Left out entirely: bank transfer within the freight due days in force (a development default).
CREATE FUNCTION trucker.quotation_freight(
  p_content jsonb, p_at timestamptz, OUT methods text[], OUT due_days integer, OUT problems jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_variable
DECLARE
  given jsonb := p_content -> 'freight';
  f trucker.financial_setting_version := trucker.financial_settings_at(p_at);
BEGIN
  problems := '[]'::jsonb;
  IF given IS NULL OR jsonb_typeof(given) = 'null' THEN
    methods := ARRAY['bank_transfer'];
    due_days := f.freight_due_days;
    RETURN;
  END IF;
  IF jsonb_typeof(given) <> 'object' OR jsonb_typeof(given -> 'methods') IS DISTINCT FROM 'array'
     OR jsonb_array_length(given -> 'methods') = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(given -> 'methods') e
                WHERE jsonb_typeof(e) <> 'string'
                   OR e #>> '{}' NOT IN ('cash_on_delivery', 'bank_transfer', 'card_gateway'))
     OR (SELECT count(*) <> count(DISTINCT e) FROM jsonb_array_elements(given -> 'methods') e) THEN
    problems := problems || jsonb_build_object('field', 'freight.methods', 'code', 'invalid');
    RETURN;
  END IF;
  methods := ARRAY(SELECT e FROM jsonb_array_elements_text(given -> 'methods') e
                   ORDER BY array_position(ARRAY['cash_on_delivery', 'bank_transfer', 'card_gateway'], e));
  IF 'card_gateway' = ANY (methods) THEN
    -- A carrier's own gateway is offered only once activated; no activation exists yet.
    problems := problems || jsonb_build_object('field', 'freight.methods', 'code', 'card_gateway_not_active');
  END IF;
  IF methods && ARRAY['bank_transfer', 'card_gateway'] THEN
    IF jsonb_typeof(given -> 'dueDays') IS DISTINCT FROM 'number' OR (given ->> 'dueDays') !~ '^[0-9]{1,3}$'
       OR (given ->> 'dueDays')::integer > f.freight_due_days THEN
      problems := problems || jsonb_build_object('field', 'freight.dueDays', 'code', 'out_of_range',
                                                 'max', f.freight_due_days);
    ELSE
      due_days := (given ->> 'dueDays')::integer;
    END IF;
  ELSIF jsonb_typeof(given -> 'dueDays') IS NOT NULL AND jsonb_typeof(given -> 'dueDays') <> 'null' THEN
    problems := problems || jsonb_build_object('field', 'freight.dueDays', 'code', 'not_applicable');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION trucker.submit_quotation(p_shipment uuid, p_key text, p_content jsonb, p_allow_fixtures boolean, OUT status text, OUT quotation_id uuid, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.shipment_draft;
  t trucker.shipment_quotation_terms;
  g trucker.security_setting;
  c record;
  fr record;
  seen record;
  made trucker.quotation;
  v_at timestamptz;
  hash text := trucker.content_hash(coalesce(p_content, 'null'::jsonb) || jsonb_build_object('_s', p_shipment));
BEGIN
  IF p_shipment IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO entered FROM trucker.discovery_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment FOR SHARE;
  v_at := trucker.clock_now();
  SELECT * INTO seen FROM trucker.quotation_retry_seen(entered.actor, p_key, 'submit', hash, v_at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' AND EXISTS (
                SELECT 1 FROM trucker.quotation q WHERE q.id = seen.record_id AND q.carrier_organisation_id = entered.org)
              THEN 'repeated' ELSE 'key_conflict' END;
    quotation_id := CASE WHEN status = 'repeated' THEN seen.record_id END;
    RETURN;
  END IF;
  IF d.id IS NULL OR NOT trucker.shipment_discoverable(d, entered.org, v_at, entered.countries, entered.equipment,
                                                        p_allow_fixtures) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO t FROM trucker.shipment_quotation_terms x WHERE x.shipment_id = d.id;
  IF NOT FOUND OR NOT trucker.quotation_registers_available(p_allow_fixtures) THEN
    status := 'terms_missing';
    RETURN;
  END IF;
  PERFORM trucker.quotation_expire_shipment(d.id, v_at);
  IF EXISTS (SELECT 1 FROM trucker.quotation q
             WHERE q.shipment_id = d.id AND q.carrier_organisation_id = entered.org AND q.status = 'submitted') THEN
    status := 'exists';
    RETURN;
  END IF;
  SELECT * INTO g FROM trucker.security_setting;
  IF (SELECT count(*) FROM trucker.quotation q
      WHERE q.carrier_organisation_id = entered.org AND q.status = 'submitted') >= g.quotation_open_limit THEN
    status := 'limit';
    detail := jsonb_build_object('limit', g.quotation_open_limit);
    RETURN;
  END IF;
  SELECT * INTO c FROM trucker.quotation_content(p_content, d, t, v_at);
  SELECT * INTO fr FROM trucker.quotation_freight(p_content, v_at);
  c.problems := c.problems || fr.problems;
  IF c.problems <> '[]'::jsonb THEN
    status := 'invalid';
    detail := c.problems;
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.quotation
      (shipment_id, shipper_organisation_id, carrier_organisation_id, publication_cycle, status,
       current_version, valid_until, created_at, created_by, updated_at)
    VALUES (d.id, d.organisation_id, entered.org, d.publication_cycle, 'submitted', 1, c.valid_until,
            v_at, entered.actor, v_at)
    RETURNING * INTO made;
  EXCEPTION WHEN unique_violation THEN
    -- Another request from the same organisation quoted first.
    status := 'exists';
    RETURN;
  END;
  INSERT INTO trucker.quotation_version
    (quotation_id, version_no, kind, amount, currency_code, inclusions,
     valid_until_local, valid_until_offset_minutes, valid_until,
     earliest_pickup_local, earliest_pickup_offset_minutes, earliest_pickup_at, notes,
     shipment_version, created_at, created_by, freight_methods, freight_due_days)
  VALUES (made.id, 1, 'submitted', c.amount, t.currency_code, c.inclusions,
          c.valid_until_local, c.valid_until_offset_minutes, c.valid_until,
          c.earliest_pickup_local, c.earliest_pickup_offset_minutes, c.earliest_pickup_at, c.notes,
          d.published_version, v_at, entered.actor, fr.methods, fr.due_days);
  INSERT INTO trucker.quotation_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (entered.actor, p_key, 'submit', hash, made.id, v_at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, after_values)
  VALUES (v_at, entered.actor, entered.org, 'quotation.submitted', 'quotation', made.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('shipment', d.id, 'version', 1, 'shipmentVersion', d.published_version));
  status := 'submitted';
  quotation_id := made.id;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.revise_quotation(p_quotation uuid, p_expected_version integer, p_key text, p_content jsonb, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  e record;
  q trucker.quotation;
  d trucker.shipment_draft;
  t trucker.shipment_quotation_terms;
  g trucker.security_setting;
  c record;
  fr record;
  seen record;
  cur trucker.quotation_version;
  may text;
  hash text := trucker.content_hash(coalesce(p_content, 'null'::jsonb) || jsonb_build_object('_v', p_expected_version));
BEGIN
  IF p_quotation IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO e FROM trucker.quotation_carrier_enter(p_quotation);
  status := e.status;
  q := e.q;
  d := e.d;
  IF status NOT IN ('ok', 'not_carrier') THEN
    RETURN;
  END IF;
  SELECT * INTO seen FROM trucker.quotation_retry_seen(e.actor, p_key, 'revise', hash, e.at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' AND seen.record_id = p_quotation THEN 'repeated' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF status = 'not_carrier' THEN
    RETURN;
  END IF;
  may := trucker.quotation_carrier_may_change(q, d, e.at, p_allow_fixtures);
  IF may <> 'ok' THEN
    status := may;
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM q.current_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  SELECT * INTO g FROM trucker.security_setting;
  IF (SELECT count(*) FROM trucker.quotation_version v
      WHERE v.quotation_id = q.id AND v.kind <> 'reconfirmed') >= g.quotation_version_limit THEN
    status := 'limit';
    detail := jsonb_build_object('limit', g.quotation_version_limit);
    RETURN;
  END IF;
  SELECT * INTO t FROM trucker.shipment_quotation_terms x WHERE x.shipment_id = d.id;
  SELECT * INTO c FROM trucker.quotation_content(p_content, d, t, e.at);
  SELECT * INTO fr FROM trucker.quotation_freight(p_content, e.at);
  c.problems := c.problems || fr.problems;
  IF c.problems <> '[]'::jsonb THEN
    status := 'invalid';
    detail := c.problems;
    RETURN;
  END IF;
  SELECT * INTO cur FROM trucker.quotation_version v WHERE v.quotation_id = q.id AND v.version_no = q.current_version;
  IF cur.amount = c.amount AND cur.inclusions = c.inclusions AND cur.valid_until = c.valid_until
     AND cur.earliest_pickup_at = c.earliest_pickup_at AND cur.notes IS NOT DISTINCT FROM c.notes
     AND cur.freight_methods = fr.methods AND cur.freight_due_days IS NOT DISTINCT FROM fr.due_days
     AND NOT q.reconfirmation_needed THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'amount', 'code', 'nothing_changed'));
    RETURN;
  END IF;
  INSERT INTO trucker.quotation_version
    (quotation_id, version_no, kind, amount, currency_code, inclusions,
     valid_until_local, valid_until_offset_minutes, valid_until,
     earliest_pickup_local, earliest_pickup_offset_minutes, earliest_pickup_at, notes,
     shipment_version, created_at, created_by, freight_methods, freight_due_days)
  VALUES (q.id, q.current_version + 1, 'revised', c.amount, t.currency_code, c.inclusions,
          c.valid_until_local, c.valid_until_offset_minutes, c.valid_until,
          c.earliest_pickup_local, c.earliest_pickup_offset_minutes, c.earliest_pickup_at, c.notes,
          d.published_version, e.at, e.actor, fr.methods, fr.due_days);
  UPDATE trucker.quotation x
  SET current_version = x.current_version + 1, valid_until = c.valid_until, reconfirmation_needed = false,
      updated_at = e.at
  WHERE x.id = q.id;
  INSERT INTO trucker.quotation_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (e.actor, p_key, 'revise', hash, q.id, e.at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, before_values, after_values)
  VALUES (e.at, e.actor, e.org, 'quotation.revised', 'quotation', q.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('version', q.current_version),
          jsonb_build_object('version', q.current_version + 1, 'shipmentVersion', d.published_version));
  status := 'revised';
END
$function$;

CREATE OR REPLACE FUNCTION trucker.reconfirm_quotation(p_quotation uuid, p_expected_version integer, p_key text, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  e record;
  q trucker.quotation;
  d trucker.shipment_draft;
  seen record;
  cur trucker.quotation_version;
  may text;
  hash text := trucker.content_hash(jsonb_build_object('_v', p_expected_version));
BEGIN
  IF p_quotation IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO e FROM trucker.quotation_carrier_enter(p_quotation);
  status := e.status;
  q := e.q;
  d := e.d;
  IF status NOT IN ('ok', 'not_carrier') THEN
    RETURN;
  END IF;
  SELECT * INTO seen FROM trucker.quotation_retry_seen(e.actor, p_key, 'reconfirm', hash, e.at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' AND seen.record_id = p_quotation THEN 'repeated' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF status = 'not_carrier' THEN
    RETURN;
  END IF;
  may := trucker.quotation_carrier_may_change(q, d, e.at, p_allow_fixtures);
  IF may <> 'ok' THEN
    status := may;
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM q.current_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF NOT q.reconfirmation_needed THEN
    status := 'not_needed';
    RETURN;
  END IF;
  SELECT * INTO cur FROM trucker.quotation_version v WHERE v.quotation_id = q.id AND v.version_no = q.current_version;
  IF cur.valid_until > d.deadline_at OR cur.earliest_pickup_at < d.pickup_from_at
     OR cur.earliest_pickup_at >= d.pickup_until_at THEN
    status := 'revise_required';
    RETURN;
  END IF;
  INSERT INTO trucker.quotation_version
    (quotation_id, version_no, kind, amount, currency_code, inclusions,
     valid_until_local, valid_until_offset_minutes, valid_until,
     earliest_pickup_local, earliest_pickup_offset_minutes, earliest_pickup_at, notes,
     shipment_version, created_at, created_by, freight_methods, freight_due_days)
  VALUES (q.id, q.current_version + 1, 'reconfirmed', cur.amount, cur.currency_code, cur.inclusions,
          cur.valid_until_local, cur.valid_until_offset_minutes, cur.valid_until,
          cur.earliest_pickup_local, cur.earliest_pickup_offset_minutes, cur.earliest_pickup_at, cur.notes,
          d.published_version, e.at, e.actor, cur.freight_methods, cur.freight_due_days);
  UPDATE trucker.quotation x
  SET current_version = x.current_version + 1, reconfirmation_needed = false, updated_at = e.at
  WHERE x.id = q.id;
  INSERT INTO trucker.quotation_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (e.actor, p_key, 'reconfirm', hash, q.id, e.at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, after_values)
  VALUES (e.at, e.actor, e.org, 'quotation.reconfirmed', 'quotation', q.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('version', q.current_version + 1, 'shipmentVersion', d.published_version));
  status := 'reconfirmed';
END
$function$;

CREATE OR REPLACE FUNCTION trucker.quotation_version_values(v trucker.quotation_version, p_zone text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'versionNo', v.version_no, 'kind', v.kind,
    -- Written with exactly the currency's minor units: an amount is never rounded, only padded.
    'amount', to_char(v.amount, 'FM999999999999990' || CASE WHEN c.minor_units > 0
                                                             THEN '.' || repeat('0', c.minor_units) ELSE '' END),
    'currency', v.currency_code, 'minorUnits', c.minor_units,
    'inclusions', v.inclusions,
    'validUntil', jsonb_build_object('local', to_char(v.valid_until_local, 'YYYY-MM-DD"T"HH24:MI'),
                                     'offsetMinutes', v.valid_until_offset_minutes, 'at', v.valid_until,
                                     'timeZone', p_zone),
    'earliestPickup', jsonb_build_object('local', to_char(v.earliest_pickup_local, 'YYYY-MM-DD"T"HH24:MI'),
                                         'offsetMinutes', v.earliest_pickup_offset_minutes,
                                         'at', v.earliest_pickup_at, 'timeZone', p_zone),
    'notes', v.notes, 'shipmentVersion', v.shipment_version, 'createdAt', v.created_at,
    'freight', jsonb_build_object('methods', to_jsonb(v.freight_methods), 'dueDays', v.freight_due_days))
  FROM trucker.currency c WHERE c.code = v.currency_code
$function$;

CREATE OR REPLACE FUNCTION trucker.quotation_context(p_shipment uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.shipment_draft;
  t trucker.shipment_quotation_terms;
BEGIN
  SELECT * INTO entered FROM trucker.discovery_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment FOR SHARE;
  IF d.id IS NULL OR NOT trucker.shipment_discoverable(d, entered.org, trucker.clock_now(), entered.countries,
                                                        entered.equipment, p_allow_fixtures) THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM trucker.quotation_expire_shipment(d.id, trucker.clock_now());
  SELECT * INTO t FROM trucker.shipment_quotation_terms x WHERE x.shipment_id = d.id;
  detail := jsonb_build_object(
    'terms', CASE WHEN t.shipment_id IS NOT NULL AND trucker.quotation_registers_available(p_allow_fixtures)
                  THEN trucker.quotation_terms_values(t) END,
    'pickupWindow', jsonb_build_object('timeZone', d.pickup_time_zone,
                                       'from', to_char(d.pickup_from_local, 'YYYY-MM-DD"T"HH24:MI'),
                                       'until', to_char(d.pickup_until_local, 'YYYY-MM-DD"T"HH24:MI')),
    -- The most days after proof of delivery a carrier may give for the freight.
    'freightMaxDueDays', (trucker.financial_settings_at(trucker.clock_now())).freight_due_days,
    'quotationDeadline', jsonb_build_object('at', d.deadline_at,
                                            'local', to_char(d.deadline_local, 'YYYY-MM-DD"T"HH24:MI'),
                                            'timeZone', d.pickup_time_zone),
    'quotations', coalesce((SELECT jsonb_agg(trucker.quotation_values(q, d, trucker.clock_now(), p_allow_fixtures)
                                             ORDER BY q.created_at DESC, q.id)
                            FROM trucker.quotation q
                            WHERE q.shipment_id = d.id AND q.carrier_organisation_id = entered.org), '[]'::jsonb));
END
$function$;


-- ---------------------------------------------------------------------------------------------
-- Bookings: the fee payer from the shipment's roles; the freight method and its due rule
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.booking
  DROP CONSTRAINT booking_fee_payer_check,
  ADD CONSTRAINT booking_fee_payer_check CHECK (fee_payer IN ('shipper', 'carrier', 'organiser')),
  ADD COLUMN freight_method text CHECK (freight_method IN ('cash_on_delivery', 'bank_transfer', 'card_gateway')),
  ADD COLUMN freight_due_rule text CHECK (freight_due_rule IN ('on_delivery', 'after_proof_of_delivery')),
  ADD COLUMN freight_due_days integer CHECK (freight_due_days BETWEEN 0 AND 365),
  -- Bookings made before this migration have none of the three.
  ADD CONSTRAINT booking_freight_terms CHECK (
    (freight_method IS NULL AND freight_due_rule IS NULL AND freight_due_days IS NULL)
    OR (freight_method = 'cash_on_delivery' AND freight_due_rule = 'on_delivery' AND freight_due_days IS NULL)
    OR (freight_method IN ('bank_transfer', 'card_gateway') AND freight_due_rule = 'after_proof_of_delivery'
        AND freight_due_days IS NOT NULL));

CREATE OR REPLACE FUNCTION trucker.acceptance_terms(p_amount numeric, p_minor_units integer, d trucker.shipment_draft, p_at timestamp with time zone, OUT fee_payer text, OUT fee_basis_points integer, OUT fee_amount numeric, OUT payment_due_days integer, OUT assignment_hours integer, OUT assignment_lead_hours integer, OUT assignment_due_at timestamp with time zone, OUT positioning_minutes integer, OUT completion_minutes integer, OUT planned_start_at timestamp with time zone, OUT planned_end_at timestamp with time zone)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  f trucker.financial_setting_version;
  g trucker.security_setting;
BEGIN
  -- Shared with every other booking; an approval or a withdrawal waits, and is waited for.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('financial.settings', 0));
  f := trucker.financial_settings_at(p_at);
  SELECT * INTO g FROM trucker.security_setting;
  -- The shipment's fee payer (D-5): the contracting customer, or the organiser where it agreed.
  fee_payer := CASE WHEN (SELECT p.fee_payer_organisation_id FROM trucker.shipment_party p
                          WHERE p.shipment_id = d.id) IS DISTINCT FROM trucker.shipment_customer(d.id)
                     AND EXISTS (SELECT 1 FROM trucker.shipment_party p WHERE p.shipment_id = d.id)
                    THEN 'organiser' ELSE 'shipper' END;
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
$function$;

ALTER TABLE trucker.security_setting DROP COLUMN booking_fee_payer;

DROP FUNCTION trucker.accept_quotation(uuid, integer, text, boolean);
CREATE FUNCTION trucker.accept_quotation(p_quotation uuid, p_expected_version integer, p_key text, p_freight_method text, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  v_shipment uuid;
  v_carrier uuid;
  d trucker.shipment_draft;
  q trucker.quotation;
  v trucker.quotation_version;
  b trucker.booking;
  t record;
  seen trucker.booking_retry_key;
  g trucker.security_setting;
  v_at timestamptz;
  v_minor integer;
  v_terms trucker.shipment_quotation_terms;
  v_booking_terms trucker.booking_terms;
  other trucker.quotation;
  request text := nullif(current_setting('trucker.request_id', true), '');
  hash text := trucker.content_hash(jsonb_build_object('q', p_quotation, 'v', p_expected_version,
                                                       'm', p_freight_method));
  v_method text;
BEGIN
  IF p_quotation IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  -- Only an administrator of the shipper commits it. Anyone else: as for a missing record.
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT x.shipment_id, x.carrier_organisation_id INTO v_shipment, v_carrier
  FROM trucker.quotation x
  WHERE x.id = p_quotation AND trucker.shipment_customer(x.shipment_id) = v_org
    AND x.carrier_organisation_id <> v_org;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  -- Locks, in one order everywhere: organisations, then the shipment, then its quotations.
  PERFORM 1 FROM trucker.organisation o WHERE o.id IN (v_org, v_carrier) ORDER BY o.id FOR SHARE;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = v_shipment FOR UPDATE;
  PERFORM 1 FROM trucker.quotation x WHERE x.shipment_id = v_shipment ORDER BY x.id FOR UPDATE;
  IF d.id IS NULL OR trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  -- The clock is read only now: a request that waited is judged at the moment it proceeds.
  v_at := trucker.clock_now();
  SELECT * INTO g FROM trucker.security_setting;
  SELECT * INTO seen FROM trucker.booking_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  IF FOUND AND seen.created_at <= v_at - make_interval(hours => g.retry_key_retention_hours) THEN
    DELETE FROM trucker.booking_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  ELSIF FOUND THEN
    SELECT * INTO b FROM trucker.booking x WHERE x.id = seen.record_id AND x.quotation_id = p_quotation;
    IF FOUND AND seen.request_hash = hash THEN
      status := 'repeated';
      detail := trucker.booking_money(b, 'shipper');
    ELSE
      status := 'key_conflict';
      PERFORM trucker.acceptance_refused(v_at, actor, v_org, p_quotation, status, p_expected_version, NULL);
    END IF;
    RETURN;
  END IF;
  -- Expiry that is due is recorded first, so an acceptance one moment late finds it expired.
  PERFORM trucker.quotation_expire_shipment(d.id, v_at);
  SELECT * INTO q FROM trucker.quotation x WHERE x.id = p_quotation;
  status := trucker.acceptance_check(q, d, v_at, p_allow_fixtures);
  IF status = 'ok' AND q.current_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
  END IF;
  IF status <> 'ok' THEN
    -- Every refusal from here is recorded: who asked, when, and why nothing was accepted.
    PERFORM trucker.acceptance_refused(v_at, actor, v_org, p_quotation, status, p_expected_version,
                                       CASE WHEN status = 'conflict' THEN q.current_version END);
    RETURN;
  END IF;
  v_booking_terms := trucker.booking_terms_current();
  SELECT * INTO v FROM trucker.quotation_version x WHERE x.quotation_id = q.id AND x.version_no = q.current_version;
  -- The freight method, one of those the quotation offers; chosen by the customer, or the
  -- only one offered.
  v_method := coalesce(p_freight_method,
                       CASE WHEN cardinality(v.freight_methods) = 1 THEN v.freight_methods[1] END);
  IF v_method IS NULL OR NOT (v_method = ANY (v.freight_methods)) THEN
    status := 'freight_method';
    detail := jsonb_build_array(jsonb_build_object(
      'field', 'freightMethod', 'code', CASE WHEN v_method IS NULL THEN 'required' ELSE 'not_offered' END));
    RETURN;
  END IF;
  SELECT c.minor_units INTO v_minor FROM trucker.currency c WHERE c.code = v.currency_code;
  SELECT * INTO v_terms FROM trucker.shipment_quotation_terms x WHERE x.shipment_id = d.id;
  SELECT * INTO t FROM trucker.acceptance_terms(v.amount, v_minor, d, v_at);

  INSERT INTO trucker.booking
    (shipment_id, shipment_version, quotation_id, quotation_version, shipper_organisation_id,
     carrier_organisation_id, currency_code, minor_units, transport_amount, fee_payer, fee_basis_points,
     fee_amount, payment_due_days, terms_code, terms_version, terms_demonstration, terms_hash,
     quotation_snapshot, inclusions, shipment_snapshot,
     pickup_from_at, pickup_until_at, delivery_from_at, delivery_until_at,
     assignment_hours, assignment_lead_hours, assignment_due_at,
     positioning_minutes, completion_minutes, planned_start_at, planned_end_at, accepted_by, accepted_at,
     freight_method, freight_due_rule, freight_due_days)
  VALUES
    (d.id, d.published_version, q.id, q.current_version, v_org,
     q.carrier_organisation_id, v.currency_code, v_minor, v.amount, t.fee_payer, t.fee_basis_points,
     t.fee_amount, t.payment_due_days, v_booking_terms.code, v_booking_terms.version_no,
     v_booking_terms.demonstration, v_booking_terms.content_hash,
     trucker.quotation_version_values(v, d.pickup_time_zone),
     coalesce((SELECT jsonb_agg(jsonb_build_object(
                 'code', i.code, 'included', (v.inclusions ->> i.code)::boolean,
                 'name', jsonb_build_object('en', i.name_en, 'ar', i.name_ar, 'ur', i.name_ur)) ORDER BY x.n)
               FROM unnest(v_terms.inclusions) WITH ORDINALITY x(code, n)
               JOIN trucker.quotation_inclusion i ON i.code = x.code), '[]'::jsonb),
     trucker.shipment_carrier_values(d, v_at),
     d.pickup_from_at, d.pickup_until_at, d.delivery_from_at, d.delivery_until_at,
     t.assignment_hours, t.assignment_lead_hours, t.assignment_due_at,
     t.positioning_minutes, t.completion_minutes, t.planned_start_at, t.planned_end_at, actor, v_at,
     v_method, CASE WHEN v_method = 'cash_on_delivery' THEN 'on_delivery' ELSE 'after_proof_of_delivery' END,
     CASE WHEN v_method = 'cash_on_delivery' THEN NULL ELSE v.freight_due_days END)
  RETURNING * INTO b;

  UPDATE trucker.quotation x SET status = 'accepted', ended_at = v_at, updated_at = v_at WHERE x.id = q.id;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, publication_cycle, before_values, after_values)
  VALUES (v_at, actor, q.carrier_organisation_id, 'quotation.accepted', 'quotation', q.id, request, d.publication_cycle,
          jsonb_build_object('status', 'submitted', 'version', q.current_version),
          jsonb_build_object('status', 'accepted', 'booking', b.id));
  FOR other IN SELECT * FROM trucker.quotation x
               WHERE x.shipment_id = d.id AND x.status = 'submitted' ORDER BY x.id LOOP
    UPDATE trucker.quotation x SET status = 'not_selected', ended_at = v_at, updated_at = v_at WHERE x.id = other.id;
    INSERT INTO trucker.audit_entry
      (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, publication_cycle, before_values, after_values)
    VALUES (v_at, actor, other.carrier_organisation_id, 'quotation.not_selected', 'quotation', other.id, request, d.publication_cycle,
            jsonb_build_object('status', 'submitted', 'version', other.current_version),
            jsonb_build_object('status', 'not_selected'));
  END LOOP;
  UPDATE trucker.shipment_draft x
  SET status = 'awarded', awarded_at = v_at, version = x.version + 1, updated_at = v_at WHERE x.id = d.id;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, publication_cycle, before_values, after_values)
  VALUES
    (v_at, actor, d.organisation_id, 'shipment.awarded', 'shipment_draft', d.id, request, d.publication_cycle,
     jsonb_build_object('status', 'published', 'publishedVersion', d.published_version),
     jsonb_build_object('status', 'awarded', 'booking', b.id)),
    (v_at, actor, v_org, 'booking.created', 'booking', b.id, request, d.publication_cycle, NULL,
     jsonb_build_object('status', 'awaiting_resources', 'quotation', q.id, 'quotationVersion', q.current_version,
                        'transportAmount', trucker.amount_text(b.transport_amount, b.minor_units),
                        'feeAmount', trucker.amount_text(b.fee_amount, b.minor_units),
                        'currency', b.currency_code, 'assignmentDueAt', b.assignment_due_at,
                        'terms', trucker.booking_terms_values(
                          b.terms_code, b.terms_version, b.terms_demonstration, b.terms_hash)));
  INSERT INTO trucker.booking_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (actor, p_key, 'accept', hash, b.id, v_at);
  status := 'accepted';
  detail := trucker.booking_money(b, 'shipper');
END
$function$;

CREATE OR REPLACE FUNCTION trucker.acceptance_preview(q trucker.quotation, d trucker.shipment_draft, p_at timestamp with time zone, p_allow_fixtures boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
DECLARE
  v trucker.quotation_version;
  t record;
  v_minor integer;
  v_state text := trucker.acceptance_check(q, d, p_at, p_allow_fixtures);
  v_terms trucker.booking_terms := trucker.booking_terms_current();
BEGIN
  IF v_state = 'closed' THEN
    RETURN jsonb_build_object('quotationId', q.id, 'state', v_state);
  END IF;
  SELECT * INTO v FROM trucker.quotation_version x WHERE x.quotation_id = q.id AND x.version_no = q.current_version;
  SELECT c.minor_units INTO v_minor FROM trucker.currency c WHERE c.code = v.currency_code;
  SELECT * INTO t FROM trucker.acceptance_terms(v.amount, v_minor, d, p_at);
  RETURN jsonb_build_object(
    'quotationId', q.id, 'version', q.current_version, 'state', v_state,
    'currency', v.currency_code,
    'transportAmount', trucker.amount_text(v.amount, v_minor),
    'fee', jsonb_build_object('payer', t.fee_payer, 'basisPoints', t.fee_basis_points, 'rounding', 'half_up',
                              'amount', trucker.amount_text(t.fee_amount, v_minor)),
    'shipperTotal', trucker.amount_text(
      v.amount + CASE WHEN t.fee_payer = 'shipper' THEN t.fee_amount ELSE 0 END, v_minor),
    'paymentDueDays', v.freight_due_days,
    'freight', jsonb_build_object('methods', to_jsonb(v.freight_methods), 'dueDays', v.freight_due_days),
    'terms', trucker.booking_terms_values(v_terms.code, v_terms.version_no, v_terms.demonstration, v_terms.content_hash),
    'assignmentDueAt', CASE WHEN v_state = 'ok' THEN t.assignment_due_at END);
END
$function$;


-- ---------------------------------------------------------------------------------------------
-- The price record of a booking
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.booking_price (
  booking_id uuid PRIMARY KEY REFERENCES trucker.booking (id),
  -- Made before this migration: no freight terms, possibly no settings version, possibly a
  -- carrier paying the fee under the earlier model.
  made_before_breakdown boolean NOT NULL,
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  minor_units integer NOT NULL,
  rounding text NOT NULL CHECK (rounding = 'half_up'),
  shipping_amount numeric NOT NULL CHECK (shipping_amount > 0),
  commission_option text CHECK (commission_option IN ('percentage', 'fixed', 'contract')),
  commission_basis_points integer,
  commission_contract_id uuid REFERENCES trucker.commission_contract (id),
  commission_amount numeric NOT NULL CHECK (commission_amount >= 0),
  carrier_net numeric NOT NULL CHECK (carrier_net > 0),
  organiser_organisation_id uuid REFERENCES trucker.organisation (id),
  fee_method text NOT NULL CHECK (fee_method = 'percentage_of_shipping_price'),
  fee_basis_points integer NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 5000),
  fee_amount numeric NOT NULL CHECK (fee_amount >= 0),
  fee_payer text NOT NULL CHECK (fee_payer IN ('customer', 'organiser', 'carrier')),
  fee_payer_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  customer_total numeric NOT NULL,
  freight_payer text CHECK (freight_payer IN ('customer', 'sender', 'receiver')),
  freight_method text,
  freight_due_rule text,
  freight_due_days integer,
  financial_setting_version_id uuid REFERENCES trucker.financial_setting_version (id),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT booking_price_adds_up CHECK (
    shipping_amount = commission_amount + carrier_net
    AND fee_amount = round(shipping_amount * fee_basis_points / 10000, minor_units)
    AND customer_total = shipping_amount + CASE WHEN fee_payer = 'customer' THEN fee_amount ELSE 0 END
    AND scale(shipping_amount) <= minor_units AND scale(commission_amount) <= minor_units
    AND (commission_option IS NULL) = (commission_amount = 0)),
  CONSTRAINT booking_price_payer CHECK (
    fee_payer <> 'organiser' OR fee_payer_organisation_id = organiser_organisation_id),
  CONSTRAINT booking_price_current CHECK (
    made_before_breakdown
    OR (fee_payer <> 'carrier' AND freight_method IS NOT NULL AND freight_payer IS NOT NULL
        AND financial_setting_version_id IS NOT NULL))
);
ALTER TABLE trucker.booking_price ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_price FROM trucker_app, PUBLIC;

CREATE FUNCTION trucker.guard_booking_price() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'the price of a booking is never changed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER booking_price_guard BEFORE UPDATE OR DELETE ON trucker.booking_price
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_booking_price();
CREATE TRIGGER booking_price_truncate_guard BEFORE TRUNCATE ON trucker.booking_price
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_booking_price();

-- Written when the booking is, after its commission and its roles (triggers run in name order).
CREATE FUNCTION trucker.booking_price_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  c trucker.booking_commission;
  p trucker.booking_party;
  sp trucker.shipment_party;
  v_payer uuid;
BEGIN
  SELECT * INTO c FROM trucker.booking_commission x WHERE x.booking_id = NEW.id;
  SELECT * INTO p FROM trucker.booking_party x WHERE x.booking_id = NEW.id;
  SELECT * INTO sp FROM trucker.shipment_party x WHERE x.shipment_id = NEW.shipment_id;
  v_payer := CASE NEW.fee_payer WHEN 'shipper' THEN NEW.shipper_organisation_id
                                WHEN 'organiser' THEN p.organiser_organisation_id
                                ELSE NEW.carrier_organisation_id END;
  -- The fee payer of the price is the one the roles recorded; the commission is in the
  -- booking's currency.
  IF v_payer IS DISTINCT FROM p.fee_payer_organisation_id
     OR (c.booking_id IS NOT NULL AND c.currency_code <> NEW.currency_code) THEN
    RAISE EXCEPTION 'the price of a booking does not match its roles or its commission'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO trucker.booking_price
    (booking_id, made_before_breakdown, currency_code, minor_units, rounding, shipping_amount,
     commission_option, commission_basis_points, commission_contract_id, commission_amount, carrier_net,
     organiser_organisation_id, fee_method, fee_basis_points, fee_amount, fee_payer, fee_payer_organisation_id,
     customer_total, freight_payer, freight_method, freight_due_rule, freight_due_days,
     financial_setting_version_id, recorded_at)
  VALUES
    (NEW.id, false, NEW.currency_code, NEW.minor_units, NEW.fee_rounding, NEW.transport_amount,
     c.option, c.basis_points, c.contract_id, coalesce(c.commission_amount, 0),
     NEW.transport_amount - coalesce(c.commission_amount, 0),
     p.organiser_organisation_id, 'percentage_of_shipping_price', NEW.fee_basis_points, NEW.fee_amount,
     CASE NEW.fee_payer WHEN 'shipper' THEN 'customer' WHEN 'organiser' THEN 'organiser' ELSE 'carrier' END,
     v_payer, NEW.transport_amount + CASE WHEN NEW.fee_payer = 'shipper' THEN NEW.fee_amount ELSE 0 END,
     sp.freight_payer, NEW.freight_method, NEW.freight_due_rule, NEW.freight_due_days,
     NEW.financial_setting_version_id, NEW.accepted_at);
  RETURN NEW;
END
$$;
CREATE TRIGGER booking_price_record AFTER INSERT ON trucker.booking
  FOR EACH ROW EXECUTE FUNCTION trucker.booking_price_record();

-- Bookings made before this migration: the figures they were made with, commission included.
INSERT INTO trucker.booking_price
  (booking_id, made_before_breakdown, currency_code, minor_units, rounding, shipping_amount,
   commission_option, commission_basis_points, commission_contract_id, commission_amount, carrier_net,
   organiser_organisation_id, fee_method, fee_basis_points, fee_amount, fee_payer, fee_payer_organisation_id,
   customer_total, freight_payer, freight_method, freight_due_rule, freight_due_days,
   financial_setting_version_id, recorded_at)
SELECT b.id, true, b.currency_code, b.minor_units, b.fee_rounding, b.transport_amount,
       c.option, c.basis_points, c.contract_id, coalesce(c.commission_amount, 0),
       b.transport_amount - coalesce(c.commission_amount, 0),
       p.organiser_organisation_id, 'percentage_of_shipping_price', b.fee_basis_points, b.fee_amount,
       CASE b.fee_payer WHEN 'shipper' THEN 'customer' ELSE 'carrier' END,
       CASE b.fee_payer WHEN 'shipper' THEN b.shipper_organisation_id ELSE b.carrier_organisation_id END,
       b.transport_amount + CASE WHEN b.fee_payer = 'shipper' THEN b.fee_amount ELSE 0 END,
       (SELECT sp.freight_payer FROM trucker.shipment_party sp WHERE sp.shipment_id = b.shipment_id),
       NULL, NULL, NULL, b.financial_setting_version_id, b.accepted_at
FROM trucker.booking b
LEFT JOIN trucker.booking_commission c ON c.booking_id = b.id
LEFT JOIN trucker.booking_party p ON p.booking_id = b.id;

-- ---------------------------------------------------------------------------------------------
-- Views by role. Nothing a role should not see leaves the database for a screen to hide.
--   p_role: customer | carrier | organiser | staff
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.booking_price_values(p trucker.booking_price, p_role text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
      'currency', p.currency_code, 'minorUnits', p.minor_units, 'rounding', p.rounding,
      'shippingPrice', trucker.amount_text(p.shipping_amount, p.minor_units),
      'freight', jsonb_build_object('payer', p.freight_payer, 'method', p.freight_method,
                                    'dueRule', p.freight_due_rule, 'dueDays', p.freight_due_days),
      'madeBeforeBreakdown', p.made_before_breakdown)
    -- The fee: to the customer, to staff, and to the one who pays it.
    || CASE WHEN p_role IN ('customer', 'staff') OR (p_role = 'organiser' AND p.fee_payer = 'organiser')
                 OR (p_role = 'carrier' AND p.fee_payer = 'carrier')
            THEN jsonb_build_object('fee', jsonb_build_object(
                   'method', p.fee_method, 'basisPoints', p.fee_basis_points,
                   'amount', trucker.amount_text(p.fee_amount, p.minor_units), 'payer', p.fee_payer))
            ELSE '{}'::jsonb END
    -- What the customer pays in all: to the customer and to staff.
    || CASE WHEN p_role IN ('customer', 'staff')
            THEN jsonb_build_object('total', trucker.amount_text(p.customer_total, p.minor_units))
            ELSE '{}'::jsonb END
    -- The commission and the carrier's net: to the carrier, the organiser and staff.
    || CASE WHEN p_role IN ('carrier', 'organiser', 'staff')
            THEN jsonb_build_object(
                   'commission', CASE WHEN p.commission_option IS NOT NULL THEN jsonb_build_object(
                                   'option', p.commission_option, 'basisPoints', p.commission_basis_points,
                                   'contract', p.commission_contract_id IS NOT NULL,
                                   'amount', trucker.amount_text(p.commission_amount, p.minor_units)) END,
                   'net', trucker.amount_text(p.carrier_net, p.minor_units))
            ELSE '{}'::jsonb END
    || CASE WHEN p_role = 'staff'
            THEN jsonb_build_object('financialSettingVersionId', p.financial_setting_version_id,
                                    'organiserId', p.organiser_organisation_id,
                                    'feePayerId', p.fee_payer_organisation_id)
            ELSE '{}'::jsonb END
$$;

-- A booking's figures for one audience: the price, and the older fields of each role kept as
-- they were, without what that role is not to see.
CREATE FUNCTION trucker.booking_money(b trucker.booking, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT (trucker.booking_values(b) - 'fee' - 'shipperTotal' - 'carrierNet' - 'paymentDueDays')
    || jsonb_build_object(
         'price', trucker.booking_price_values(p, CASE p_audience WHEN 'shipper' THEN 'customer' ELSE p_audience END),
         -- Days after proof of delivery; nothing for cash on delivery.
         'paymentDueDays', CASE WHEN b.freight_method IS NULL THEN b.payment_due_days ELSE b.freight_due_days END)
    || CASE WHEN p_audience IN ('shipper', 'staff') OR (p_audience = 'carrier' AND b.fee_payer = 'carrier')
            THEN jsonb_build_object('fee', jsonb_build_object(
                   'payer', b.fee_payer, 'basisPoints', b.fee_basis_points, 'rounding', b.fee_rounding,
                   'amount', trucker.amount_text(b.fee_amount, b.minor_units)))
            ELSE '{}'::jsonb END
    || CASE WHEN p_audience IN ('shipper', 'staff')
            THEN jsonb_build_object('shipperTotal', trucker.amount_text(p.customer_total, p.minor_units))
            ELSE '{}'::jsonb END
    || CASE WHEN p_audience IN ('carrier', 'staff')
            THEN jsonb_build_object('carrierNet', trucker.amount_text(p.carrier_net, p.minor_units))
            ELSE '{}'::jsonb END
  FROM trucker.booking_price p WHERE p.booking_id = b.id
$$;

CREATE OR REPLACE FUNCTION trucker.booking_view(b trucker.booking, p_audience text, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  c trucker.booking_confirmation;
  w trucker.booking_wait_decision;
  s trucker.booking_substitution;
  cur record;
  v_set integer;
  v_blockers jsonb := trucker.booking_dispatch_blockers(b, p_at);
  v_shown jsonb;
  v_acknowledged timestamptz;
BEGIN
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    RETURN trucker.booking_money(b, p_audience) || jsonb_build_object(
      'status','cancelled','confirmedAt',(SELECT x.confirmed_at FROM trucker.booking_confirmation x WHERE x.booking_id=b.id),
      'overdue',false,'waitDecision',NULL,'assignmentVersion',
      coalesce((SELECT x.set_no FROM trucker.booking_assignment_state x WHERE x.booking_id=b.id),0),
      'dispatch',jsonb_build_object('ready',false,'blockers',jsonb_build_array(jsonb_build_object('code','booking_cancelled'))),
      'needsReassignment',false,'atRisk',false,'acknowledgedAt',NULL,'resources',NULL,'substitution',NULL,'site',NULL,
      'vehicleChanges',trucker.vehicle_changes(b.id),
      'cancellation',trucker.cancellation_values(b.id,p_audience));
  END IF;
  SELECT * INTO c FROM trucker.booking_confirmation x WHERE x.booking_id = b.id;
  SELECT * INTO w FROM trucker.booking_wait_decision x WHERE x.booking_id = b.id;
  SELECT * INTO s FROM trucker.booking_substitution x WHERE x.booking_id = b.id AND x.status = 'proposed';
  SELECT * INTO cur FROM trucker.assignment_current(b.id);
  SELECT coalesce((SELECT x.set_no FROM trucker.booking_assignment_state x WHERE x.booking_id = b.id), 0) INTO v_set;
  SELECT k.acknowledged_at INTO v_acknowledged FROM trucker.assignment_acknowledgement k
  WHERE k.booking_id = b.id AND k.set_no = v_set AND k.person_id = cur.driver;
  -- The shipper is told that something blocks dispatch, not what is wrong with whose resource.
  IF p_audience = 'shipper' THEN
    SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('code', x ->> 'code')), '[]'::jsonb) INTO v_shown
    FROM jsonb_array_elements(v_blockers) AS x;
  ELSE
    v_shown := v_blockers;
  END IF;
  RETURN trucker.booking_money(b, p_audience) || jsonb_build_object(
    'status', CASE WHEN c.booking_id IS NOT NULL THEN 'confirmed' ELSE 'awaiting_resources' END,
    'confirmedAt', c.confirmed_at,
    'overdue', c.booking_id IS NULL AND p_at > b.assignment_due_at,
    'waitDecision', CASE WHEN w.booking_id IS NOT NULL THEN jsonb_build_object('decidedAt', w.decided_at) END,
    'assignmentVersion', v_set,
    'dispatch', jsonb_build_object('ready', jsonb_array_length(v_blockers) = 0, 'blockers', v_shown),
    'needsReassignment', v_blockers @> '[{"code": "needs_reassignment"}]'::jsonb,
    'atRisk', v_blockers @> '[{"code": "resource_overrunning"}]'::jsonb,
    'acknowledgedAt', v_acknowledged,
    'resources', CASE WHEN p_audience <> 'shipper' OR c.booking_id IS NOT NULL
                      THEN trucker.assignment_set_values(cur.truck, cur.trailer, cur.affiliation, p_audience) END,
    'substitution', CASE WHEN s.id IS NOT NULL THEN trucker.substitution_values(s, p_audience) END,
    'vehicleChanges', trucker.vehicle_changes(b.id),
    'site', CASE WHEN p_audience <> 'shipper' AND c.booking_id IS NOT NULL THEN c.site_details END);
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
      -- The organiser's view of the price of the booking made from it, once there is one.
      'bookedPrice', (SELECT trucker.booking_price_values(p, 'organiser') FROM trucker.booking_price p
                      JOIN trucker.booking b ON b.id = p.booking_id
                      WHERE b.shipment_id = d.id AND p.organiser_organisation_id = v_org
                        AND trucker.shipment_customer(d.id) <> v_org
                      ORDER BY b.accepted_at DESC LIMIT 1),
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

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.accept_quotation(uuid, integer, text, text, boolean)
TO trucker_app;
