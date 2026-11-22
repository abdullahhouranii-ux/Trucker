-- 0010_quotations
-- Quotations. A carrier that can discover a published shipment (0009) quotes for it: an exact
-- amount in the shipment's currency, an answer for every inclusion of the shipment's terms, a
-- validity and the earliest pick-up it can meet. It may revise, reconfirm after a material
-- change to the shipment, or withdraw. The shipper sees every quotation on its shipments,
-- compares them and may reject one. Nothing is accepted, awarded, booked, reserved, invoiced or
-- paid, and no fee exists.
--
-- Decisions recorded on 15 November 2026 (docs/delivery/QUOTATION_SLICE_12_SCOPE.md):
--   QB-1  carrier quotations; QB-2 no acceptance in this slice;
--   QB-3  one currency per shipment, chosen by the shipper from those configured for the
--         pick-up country, and locked once any quotation exists;
--   QB-4  one all-in amount plus an answer for every inclusion of the shipment's terms; the
--         inclusion register is fictional until the real one is approved;
--   QB-5  the shipper sees the carrier's name; carriers never see one another;
--   QB-6  the carrier revises its own quotation; no shipper counter-offers;
--   QB-7  no resource is named;
--   QB-8  validity no later than the shipment's quotation deadline;
--   QB-9  a material change marks open quotations for reconfirmation;
--   QB-10 a withdrawn shipment closes open quotations; an expired one lets them expire; a
--         suspended one freezes them, without pausing their expiry;
--   QB-11 development limits, needing production review.
-- Safeguards given with the approval: exact decimal amounts; the same inclusions answered by
-- every quotation on a shipment; suspension never pauses expiry; resumption rechecks
-- eligibility, validity and reconfirmation (a quotation's standing is judged live).

-- ---------------------------------------------------------------------------------------------
-- Registers: currencies and inclusions. Empty after the migrations. Fictional entries exist
-- only in databases marked local-development or test.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.currency (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  minor_units integer NOT NULL CHECK (minor_units BETWEEN 0 AND 3),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 80)
);
CREATE TABLE trucker.country_currency (
  country_code text NOT NULL REFERENCES trucker.country (code),
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  PRIMARY KEY (country_code, currency_code)
);
CREATE TABLE trucker.quotation_inclusion (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 120),
  name_ar text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 120),
  name_ur text NOT NULL CHECK (length(btrim(name_ur)) BETWEEN 1 AND 120),
  position integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE trucker.quotation_inclusion IS
  'Fictional until the real register is approved. Not a statement of what any price must include.';
COMMENT ON TABLE trucker.currency IS
  'Empty in production until launch countries are decided. Development uses the ISO 4217 test code XTS.';
CREATE TRIGGER currency_guard BEFORE INSERT OR UPDATE ON trucker.currency
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_catalogue();
CREATE TRIGGER country_currency_guard BEFORE INSERT OR UPDATE ON trucker.country_currency
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_catalogue();
CREATE TRIGGER quotation_inclusion_guard BEFORE INSERT OR UPDATE ON trucker.quotation_inclusion
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_catalogue();
CREATE FUNCTION trucker.guard_environment_quotation_registers() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF NEW.kind NOT IN ('local-development', 'test')
     AND (EXISTS (SELECT 1 FROM trucker.currency) OR EXISTS (SELECT 1 FROM trucker.quotation_inclusion)) THEN
    RAISE EXCEPTION 'this database holds fictional quotation registers and cannot be marked %', NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER environment_guard_quotation_registers BEFORE UPDATE ON trucker.environment
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_environment_quotation_registers();
ALTER TABLE trucker.currency ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.country_currency ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.quotation_inclusion ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------
-- A shipment's quotation terms: its currency and the inclusions every quotation must answer.
-- Set by the shipper; locked once any quotation exists for the shipment.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.shipment_quotation_terms (
  shipment_id uuid PRIMARY KEY REFERENCES trucker.shipment_draft (id),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  -- A snapshot of the register when the terms were set, in its order.
  inclusions text[] NOT NULL CHECK (cardinality(inclusions) BETWEEN 1 AND 30),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  set_at timestamptz NOT NULL,
  set_by uuid NOT NULL REFERENCES trucker.person (id)
);

-- ---------------------------------------------------------------------------------------------
-- Quotations and their versions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.quotation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES trucker.shipment_draft (id),
  shipper_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  carrier_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  -- The shipment's publication cycle when the quotation was made.
  publication_cycle uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted', 'withdrawn', 'rejected', 'expired', 'closed')),
  current_version integer NOT NULL CHECK (current_version >= 1),
  valid_until timestamptz NOT NULL,
  -- A material change to the shipment since the current version (QB-9).
  reconfirmation_needed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES trucker.person (id),
  updated_at timestamptz NOT NULL,
  ended_at timestamptz,
  -- closed: the shipment was withdrawn (QB-10).
  closed_reason text CHECK (closed_reason IS NULL OR closed_reason IN ('shipment_withdrawn')),
  CONSTRAINT quotation_ended CHECK ((status = 'submitted') = (ended_at IS NULL)),
  CONSTRAINT quotation_closed CHECK ((status = 'closed') = (closed_reason IS NOT NULL)),
  CONSTRAINT quotation_not_own CHECK (shipper_organisation_id <> carrier_organisation_id)
);
-- One open quotation per carrier organisation per shipment (AT-214).
CREATE UNIQUE INDEX quotation_one_open ON trucker.quotation (shipment_id, carrier_organisation_id)
  WHERE status = 'submitted';
CREATE INDEX quotation_carrier_idx ON trucker.quotation (carrier_organisation_id, status);
CREATE INDEX quotation_shipment_idx ON trucker.quotation (shipment_id, status);

CREATE TABLE trucker.quotation_version (
  quotation_id uuid NOT NULL REFERENCES trucker.quotation (id),
  version_no integer NOT NULL CHECK (version_no >= 1),
  -- submitted: the first. revised: new values. reconfirmed: the same values, confirmed for a
  -- newer version of the shipment.
  kind text NOT NULL CHECK (kind IN ('submitted', 'revised', 'reconfirmed')),
  -- Exact, never rounded: its scale is checked against the currency when it is written.
  amount numeric NOT NULL CHECK (amount > 0 AND amount < 1000000000000),
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  -- Exactly the shipment's inclusions, each answered true or false.
  inclusions jsonb NOT NULL CHECK (jsonb_typeof(inclusions) = 'object'),
  valid_until_local timestamp NOT NULL,
  valid_until_offset_minutes integer NOT NULL,
  valid_until timestamptz NOT NULL,
  earliest_pickup_local timestamp NOT NULL,
  earliest_pickup_offset_minutes integer NOT NULL,
  earliest_pickup_at timestamptz NOT NULL,
  notes text CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 1000),
  -- The shipment's published version this version was made for.
  shipment_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES trucker.person (id),
  PRIMARY KEY (quotation_id, version_no)
);
CREATE FUNCTION trucker.guard_quotation_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a quotation version cannot be changed or removed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER quotation_version_guard BEFORE UPDATE OR DELETE ON trucker.quotation_version
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_quotation_version();

CREATE TABLE trucker.quotation_retry_key (
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9._-]{16,128}$'),
  operation text NOT NULL CHECK (operation IN ('terms', 'submit', 'revise', 'reconfirm', 'withdraw', 'reject')),
  request_hash text NOT NULL,
  record_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (person_id, key)
);

-- Shipper reads of the quotations on its shipments: who, when, which quotations. Append-only.
CREATE TABLE trucker.quotation_read_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  shipment_id uuid NOT NULL REFERENCES trucker.shipment_draft (id),
  shown uuid[] NOT NULL DEFAULT '{}',
  request_id text CHECK (request_id IS NULL OR length(request_id) <= 200)
);
CREATE TRIGGER quotation_read_log_guard BEFORE UPDATE OR DELETE ON trucker.quotation_read_log
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_carrier_access_log();
CREATE TRIGGER quotation_read_log_truncate_guard BEFORE TRUNCATE ON trucker.quotation_read_log
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_carrier_access_log();

-- Nothing here is reachable by the API's role except through the functions below.
ALTER TABLE trucker.shipment_quotation_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.quotation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.quotation_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.quotation_retry_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.quotation_read_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.currency, trucker.country_currency, trucker.quotation_inclusion,
  trucker.shipment_quotation_terms, trucker.quotation, trucker.quotation_version,
  trucker.quotation_retry_key, trucker.quotation_read_log FROM trucker_app, PUBLIC;

-- History.
ALTER TABLE trucker.audit_entry
  DROP CONSTRAINT audit_entry_action_check,
  ADD CONSTRAINT audit_entry_action_check CHECK (action IN (
    'organisation.created', 'organisation.updated',
    'shipment.created', 'shipment.updated', 'shipment.discarded',
    'shipment.published', 'shipment.version_created', 'shipment.withdrawn', 'shipment.expired',
    'shipment.republished', 'shipment.copied', 'shipment.suspended', 'shipment.suspension_ended',
    'shipment.quotation_terms_set',
    'verification.submitted', 'verification.withdrawn', 'verification.claim_raised',
    'verification.decided', 'verification.revoked', 'capability.revalidated',
    'quotation.submitted', 'quotation.revised', 'quotation.reconfirmed', 'quotation.withdrawn',
    'quotation.rejected', 'quotation.expired', 'quotation.closed',
    'quotation.reconfirmation_required')),
  DROP CONSTRAINT audit_entry_record_type_check,
  ADD CONSTRAINT audit_entry_record_type_check CHECK (record_type IN (
    'organisation', 'shipment_draft', 'verification_application', 'quotation')),
  DROP CONSTRAINT audit_entry_one_actor,
  ADD CONSTRAINT audit_entry_one_actor CHECK (
    (actor_person_id IS NULL) <> (actor_staff_id IS NULL)
    OR (actor_person_id IS NULL AND actor_staff_id IS NULL
        AND action IN ('shipment.expired', 'shipment.suspended', 'shipment.suspension_ended',
                       'quotation.expired', 'quotation.closed', 'quotation.reconfirmation_required')));
-- Each ending of a quotation is recorded once; each reconfirmation demand once per shipment version.
CREATE UNIQUE INDEX audit_entry_one_quotation_end ON trucker.audit_entry (record_id)
  WHERE action IN ('quotation.expired', 'quotation.closed', 'quotation.withdrawn', 'quotation.rejected');
CREATE UNIQUE INDEX audit_entry_one_reconfirmation ON trucker.audit_entry
  (record_id, (after_values ->> 'shipmentVersion'))
  WHERE action = 'quotation.reconfirmation_required';

-- Protected settings, development defaults needing production review (QB-11).
ALTER TABLE trucker.security_setting
  ADD COLUMN quotation_min_validity_minutes integer NOT NULL DEFAULT 15
    CHECK (quotation_min_validity_minutes BETWEEN 1 AND 10080),
  ADD COLUMN quotation_open_limit integer NOT NULL DEFAULT 100 CHECK (quotation_open_limit BETWEEN 1 AND 10000),
  ADD COLUMN quotation_version_limit integer NOT NULL DEFAULT 5 CHECK (quotation_version_limit BETWEEN 1 AND 100);
UPDATE trucker.security_setting SET reviewed_for_production = false;

-- ---------------------------------------------------------------------------------------------
-- Building blocks. None is callable by the API's role.
-- ---------------------------------------------------------------------------------------------

-- Whether a register entry may be used by this request: fictional entries exist only in marked
-- databases, and only when the request allows fixtures. There are no others yet.
CREATE FUNCTION trucker.quotation_registers_available(p_allow_fixtures boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(p_allow_fixtures, false)
     AND (SELECT e.kind FROM trucker.environment e) IN ('local-development', 'test')
$$;

-- When an open quotation ends by time: its validity, or the shipment's deadline if earlier.
CREATE FUNCTION trucker.quotation_end(q trucker.quotation, d trucker.shipment_draft) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT least(q.valid_until, d.deadline_at)
$$;

-- Records the expiry of one open quotation that is past its end, once, dated at its end.
-- Suspension does not pause it. Called with the quotation locked.
CREATE FUNCTION trucker.quotation_expire_if_due(p_quotation uuid, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  q trucker.quotation;
  d trucker.shipment_draft;
  v_end timestamptz;
BEGIN
  SELECT * INTO q FROM trucker.quotation x WHERE x.id = p_quotation FOR UPDATE;
  IF NOT FOUND OR q.status <> 'submitted' THEN
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = q.shipment_id;
  v_end := trucker.quotation_end(q, d);
  IF v_end > p_at THEN
    RETURN;
  END IF;
  UPDATE trucker.quotation x SET status = 'expired', ended_at = v_end, updated_at = p_at WHERE x.id = q.id;
  INSERT INTO trucker.audit_entry
    (occurred_at, organisation_id, action, record_type, record_id, request_id, before_values, after_values)
  VALUES (v_end, q.carrier_organisation_id, 'quotation.expired', 'quotation', q.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('status', 'submitted', 'version', q.current_version),
          jsonb_build_object('status', 'expired', 'recordedAt', p_at,
                             'by', CASE WHEN q.valid_until <= d.deadline_at THEN 'validity' ELSE 'deadline' END));
END
$$;

CREATE FUNCTION trucker.quotation_expire_shipment(p_shipment uuid, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  one uuid;
BEGIN
  FOR one IN SELECT q.id FROM trucker.quotation q
             WHERE q.shipment_id = p_shipment AND q.status = 'submitted' ORDER BY q.id LOOP
    PERFORM trucker.quotation_expire_if_due(one, p_at);
  END LOOP;
END
$$;

-- Where an open quotation stands now, judged live, nothing assumed from earlier:
--   current | needs_reconfirmation | carrier_not_eligible | shipment_suspended | expired
--   | shipment_closed, or the quotation's own status when it has ended.
CREATE FUNCTION trucker.quotation_standing(
  q trucker.quotation, d trucker.shipment_draft, p_at timestamptz, p_allow_fixtures boolean
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  s record;
BEGIN
  IF q.status <> 'submitted' THEN
    RETURN q.status;
  END IF;
  IF trucker.quotation_end(q, d) <= p_at THEN
    RETURN 'expired';
  END IF;
  IF d.status <> 'published' THEN
    RETURN 'shipment_closed';
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.shipment_suspension x WHERE x.shipment_id = d.id AND x.ended_at IS NULL)
     OR NOT trucker.organisation_publishable(d.organisation_id)
     OR trucker.route_check(d.pickup_country, d.delivery_country, p_allow_fixtures) ->> 'status' <> 'open' THEN
    RETURN 'shipment_suspended';
  END IF;
  SELECT * INTO s FROM trucker.carrier_service(q.carrier_organisation_id);
  IF NOT trucker.capability_effective(q.carrier_organisation_id, 'carry_as_company')
     OR NOT (d.pickup_country = ANY (s.countries) AND d.delivery_country = ANY (s.countries)
             AND d.equipment_type = ANY (s.equipment)) THEN
    RETURN 'carrier_not_eligible';
  END IF;
  IF q.reconfirmation_needed THEN
    RETURN 'needs_reconfirmation';
  END IF;
  RETURN 'current';
END
$$;

CREATE FUNCTION trucker.quotation_version_values(v trucker.quotation_version, p_zone text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
    'notes', v.notes, 'shipmentVersion', v.shipment_version, 'createdAt', v.created_at)
  FROM trucker.currency c WHERE c.code = v.currency_code
$$;

-- One quotation with every version, newest first, and its standing.
CREATE FUNCTION trucker.quotation_values(
  q trucker.quotation, d trucker.shipment_draft, p_at timestamptz, p_allow_fixtures boolean
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', q.id, 'shipmentId', q.shipment_id, 'status', q.status,
    'standing', trucker.quotation_standing(q, d, p_at, p_allow_fixtures),
    'currentVersion', q.current_version, 'reconfirmationNeeded', q.reconfirmation_needed,
    'shipmentVersion', d.published_version, 'closedReason', q.closed_reason,
    'createdAt', q.created_at, 'updatedAt', q.updated_at, 'endedAt', q.ended_at,
    'versions', (SELECT jsonb_agg(trucker.quotation_version_values(v, d.pickup_time_zone) ORDER BY v.version_no DESC)
                 FROM trucker.quotation_version v WHERE v.quotation_id = q.id))
$$;

CREATE FUNCTION trucker.quotation_terms_values(t trucker.shipment_quotation_terms) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'currency', t.currency_code,
    'minorUnits', (SELECT c.minor_units FROM trucker.currency c WHERE c.code = t.currency_code),
    'version', t.row_version,
    'inclusions', (SELECT jsonb_agg(jsonb_build_object(
                     'code', i.code,
                     'name', jsonb_build_object('en', i.name_en, 'ar', i.name_ar, 'ur', i.name_ur))
                     ORDER BY x.n)
                   FROM unnest(t.inclusions) WITH ORDINALITY x(code, n)
                   JOIN trucker.quotation_inclusion i ON i.code = x.code),
    'locked', EXISTS (SELECT 1 FROM trucker.quotation q WHERE q.shipment_id = t.shipment_id))
$$;

-- The content of a quotation version, checked: {"amount": "1250.50", "inclusions": {code: bool},
-- "validUntil": {"local", "offsetMinutes"}, "earliestPickup": {"local", "offsetMinutes"},
-- "notes"}. Every problem is reported by field.
CREATE FUNCTION trucker.quotation_content(
  p_content jsonb, d trucker.shipment_draft, t trucker.shipment_quotation_terms, p_at timestamptz,
  OUT amount numeric, OUT inclusions jsonb, OUT valid_until_local timestamp,
  OUT valid_until_offset_minutes integer, OUT valid_until timestamptz,
  OUT earliest_pickup_local timestamp, OUT earliest_pickup_offset_minutes integer,
  OUT earliest_pickup_at timestamptz, OUT notes text, OUT problems jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_variable
DECLARE
  g trucker.security_setting;
  minor integer;
  typed text := coalesce(p_content ->> 'amount', '');
  given jsonb := p_content -> 'inclusions';
  v_code text;
  r record;
BEGIN
  problems := '[]'::jsonb;
  SELECT * INTO g FROM trucker.security_setting;
  SELECT c.minor_units INTO minor FROM trucker.currency c WHERE c.code = t.currency_code;
  -- Exact decimal amounts only: digits, an optional point and at most the currency's minor units.
  IF typed !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,3})?$' THEN
    problems := problems || jsonb_build_object('field', 'amount', 'code', 'invalid');
  ELSE
    amount := typed::numeric;
    IF scale(amount) > minor THEN
      problems := problems || jsonb_build_object('field', 'amount', 'code', 'precision', 'minorUnits', minor);
    ELSIF amount <= 0 THEN
      problems := problems || jsonb_build_object('field', 'amount', 'code', 'not_positive');
    END IF;
  END IF;
  -- Every inclusion of the shipment's terms answered, nothing else.
  inclusions := '{}'::jsonb;
  IF jsonb_typeof(given) IS DISTINCT FROM 'object' THEN
    given := '{}'::jsonb;
  END IF;
  FOR v_code IN SELECT jsonb_object_keys(given) LOOP
    IF NOT (v_code = ANY (t.inclusions)) THEN
      problems := problems || jsonb_build_object('field', 'inclusions', 'code', 'unknown');
    END IF;
  END LOOP;
  FOREACH v_code IN ARRAY t.inclusions LOOP
    IF jsonb_typeof(given -> v_code) IS DISTINCT FROM 'boolean' THEN
      problems := problems || jsonb_build_object('field', 'inclusions.' || v_code, 'code', 'required');
    ELSE
      inclusions := inclusions || jsonb_build_object(v_code, given -> v_code);
    END IF;
  END LOOP;
  -- Validity: in the pick-up place's time, after the minimum, no later than the deadline.
  SELECT * INTO r FROM trucker.resolve_window_end(p_content -> 'validUntil', d.pickup_time_zone, 'validUntil');
  IF r.problem IS NOT NULL THEN
    problems := problems || r.problem;
  ELSIF r.instant IS NULL THEN
    problems := problems || jsonb_build_object('field', 'validUntil', 'code', 'required');
  ELSIF r.instant < p_at + make_interval(mins => g.quotation_min_validity_minutes) THEN
    problems := problems || jsonb_build_object('field', 'validUntil', 'code', 'too_soon',
                                               'minutes', g.quotation_min_validity_minutes);
  ELSIF r.instant > d.deadline_at THEN
    problems := problems || jsonb_build_object('field', 'validUntil', 'code', 'after_deadline');
  ELSE
    valid_until_local := r.local_time;
    valid_until_offset_minutes := r.offset_minutes;
    valid_until := r.instant;
  END IF;
  -- The earliest pick-up the carrier can meet: inside the pick-up window.
  SELECT * INTO r FROM trucker.resolve_window_end(p_content -> 'earliestPickup', d.pickup_time_zone, 'earliestPickup');
  IF r.problem IS NOT NULL THEN
    problems := problems || r.problem;
  ELSIF r.instant IS NULL THEN
    problems := problems || jsonb_build_object('field', 'earliestPickup', 'code', 'required');
  ELSIF r.instant < d.pickup_from_at OR r.instant >= d.pickup_until_at THEN
    problems := problems || jsonb_build_object('field', 'earliestPickup', 'code', 'outside_window');
  ELSE
    earliest_pickup_local := r.local_time;
    earliest_pickup_offset_minutes := r.offset_minutes;
    earliest_pickup_at := r.instant;
  END IF;
  notes := nullif(btrim(coalesce(p_content ->> 'notes', '')), '');
  IF notes IS NOT NULL AND length(notes) > 1000 THEN
    problems := problems || jsonb_build_object('field', 'notes', 'code', 'length');
  END IF;
END
$$;

-- A retry key seen before, checked after the caller is known and allowed (AT-251).
--   NULL: new. 'repeated': same request. 'key_conflict': anything else.
CREATE FUNCTION trucker.quotation_retry_seen(
  p_person uuid, p_key text, p_operation text, p_hash text, p_at timestamptz, OUT seen text, OUT record_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  earlier trucker.quotation_retry_key;
  g trucker.security_setting;
BEGIN
  SELECT * INTO g FROM trucker.security_setting;
  SELECT * INTO earlier FROM trucker.quotation_retry_key k WHERE k.person_id = p_person AND k.key = p_key;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF earlier.created_at <= p_at - make_interval(hours => g.retry_key_retention_hours) THEN
    DELETE FROM trucker.quotation_retry_key k WHERE k.person_id = p_person AND k.key = p_key;
    RETURN;
  END IF;
  record_id := earlier.record_id;
  seen := CASE WHEN earlier.operation = p_operation AND earlier.request_hash = p_hash
               THEN 'repeated' ELSE 'key_conflict' END;
END
$$;

-- The opening of every carrier command on an existing quotation: who is asking (an eligible
-- carrier's administrator, organisation locked first), then the shipment shared-locked, then
-- the quotation locked, then the clock, then any expiry that is due recorded.
--   status: ok | unauthorized | not_found | not_carrier | rate_limited
CREATE FUNCTION trucker.quotation_carrier_enter(
  p_quotation uuid,
  OUT status text, OUT actor uuid, OUT org uuid, OUT at timestamptz,
  OUT q trucker.quotation, OUT d trucker.shipment_draft, OUT countries text[], OUT equipment text[]
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  v_shipment uuid;
BEGIN
  SELECT * INTO entered FROM trucker.discovery_enter();
  status := entered.status;
  actor := entered.actor;
  org := entered.org;
  countries := entered.countries;
  equipment := entered.equipment;
  IF status IN ('unauthorized', 'not_found') THEN
    RETURN;
  END IF;
  SELECT x.shipment_id INTO v_shipment FROM trucker.quotation x
  WHERE x.id = p_quotation AND x.carrier_organisation_id = org;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = v_shipment FOR SHARE;
  SELECT * INTO q FROM trucker.quotation x WHERE x.id = p_quotation FOR UPDATE;
  at := trucker.clock_now();
  PERFORM trucker.quotation_expire_if_due(q.id, at);
  SELECT * INTO q FROM trucker.quotation x WHERE x.id = p_quotation;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The shipper: terms
--   p_content: {"currency": "XTS"}
--   status: set | repeated | unauthorized | not_found | not_open | locked | conflict | closed
--           | invalid | key_conflict
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.set_quotation_terms(
  p_shipment uuid, p_expected_version integer, p_key text, p_content jsonb, p_allow_fixtures boolean,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  d trucker.shipment_draft;
  t trucker.shipment_quotation_terms;
  v_at timestamptz;
  v_currency text := coalesce(p_content ->> 'currency', '');
  v_inclusions text[];
  seen record;
  hash text := trucker.content_hash(coalesce(p_content, 'null'::jsonb) || jsonb_build_object('_v', p_expected_version));
BEGIN
  IF p_shipment IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.organisation o WHERE o.id = v_org FOR SHARE;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment AND x.organisation_id = v_org FOR UPDATE;
  IF NOT FOUND OR trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  SELECT * INTO seen FROM trucker.quotation_retry_seen(actor, p_key, 'terms', hash, v_at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' AND seen.record_id = d.id THEN 'repeated' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF d.status NOT IN ('draft', 'published') THEN
    status := 'not_open';
    RETURN;
  END IF;
  SELECT * INTO t FROM trucker.shipment_quotation_terms x WHERE x.shipment_id = d.id;
  IF coalesce(t.row_version, 0) <> coalesce(p_expected_version, -1) THEN
    status := 'conflict';
    RETURN;
  END IF;
  -- Locked once any quotation exists, whatever happened to it since.
  IF EXISTS (SELECT 1 FROM trucker.quotation q WHERE q.shipment_id = d.id) THEN
    status := 'locked';
    RETURN;
  END IF;
  IF NOT trucker.quotation_registers_available(p_allow_fixtures) THEN
    status := 'closed';
    RETURN;
  END IF;
  SELECT array_agg(i.code ORDER BY i.position, i.code) INTO v_inclusions FROM trucker.quotation_inclusion i;
  IF v_inclusions IS NULL THEN
    status := 'closed';
    RETURN;
  END IF;
  IF d.pickup_country IS NULL OR NOT EXISTS (
       SELECT 1 FROM trucker.country_currency c
       WHERE c.country_code = d.pickup_country AND c.currency_code = v_currency) THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'currency', 'code', 'unavailable'));
    RETURN;
  END IF;
  INSERT INTO trucker.shipment_quotation_terms
    (shipment_id, organisation_id, currency_code, inclusions, row_version, set_at, set_by)
  VALUES (d.id, v_org, v_currency, v_inclusions, 1, v_at, actor)
  ON CONFLICT (shipment_id) DO UPDATE
    SET currency_code = EXCLUDED.currency_code, inclusions = EXCLUDED.inclusions,
        row_version = trucker.shipment_quotation_terms.row_version + 1,
        set_at = EXCLUDED.set_at, set_by = EXCLUDED.set_by
  RETURNING * INTO t;
  INSERT INTO trucker.quotation_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (actor, p_key, 'terms', hash, d.id, v_at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, after_values)
  VALUES (v_at, actor, v_org, 'shipment.quotation_terms_set', 'shipment_draft', d.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('currency', t.currency_code, 'inclusions', to_jsonb(t.inclusions),
                             'termsVersion', t.row_version));
  status := 'set';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The carrier: submit, revise, reconfirm, withdraw
-- ---------------------------------------------------------------------------------------------

--   status: submitted | repeated | unauthorized | not_found | not_carrier | rate_limited
--           | terms_missing | exists | limit | invalid | key_conflict
CREATE FUNCTION trucker.submit_quotation(
  p_shipment uuid, p_key text, p_content jsonb, p_allow_fixtures boolean,
  OUT status text, OUT quotation_id uuid, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.shipment_draft;
  t trucker.shipment_quotation_terms;
  g trucker.security_setting;
  c record;
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
     shipment_version, created_at, created_by)
  VALUES (made.id, 1, 'submitted', c.amount, t.currency_code, c.inclusions,
          c.valid_until_local, c.valid_until_offset_minutes, c.valid_until,
          c.earliest_pickup_local, c.earliest_pickup_offset_minutes, c.earliest_pickup_at, c.notes,
          d.published_version, v_at, entered.actor);
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
$$;

-- What a carrier may do with its open quotation now, checked live.
--   ok | not_open | suspended | not_eligible
CREATE FUNCTION trucker.quotation_carrier_may_change(
  q trucker.quotation, d trucker.shipment_draft, p_at timestamptz, p_allow_fixtures boolean
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE trucker.quotation_standing(q, d, p_at, p_allow_fixtures)
    WHEN 'current' THEN 'ok'
    WHEN 'needs_reconfirmation' THEN 'ok'
    WHEN 'shipment_suspended' THEN 'suspended'
    WHEN 'carrier_not_eligible' THEN 'not_eligible'
    ELSE 'not_open' END
$$;

--   status: revised | reconfirmed | repeated | unauthorized | not_found | not_carrier
--           | rate_limited | not_open | suspended | not_eligible | conflict | limit | invalid
--           | not_needed | revise_required | key_conflict
CREATE FUNCTION trucker.revise_quotation(
  p_quotation uuid, p_expected_version integer, p_key text, p_content jsonb, p_allow_fixtures boolean,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  q trucker.quotation;
  d trucker.shipment_draft;
  t trucker.shipment_quotation_terms;
  g trucker.security_setting;
  c record;
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
  IF c.problems <> '[]'::jsonb THEN
    status := 'invalid';
    detail := c.problems;
    RETURN;
  END IF;
  SELECT * INTO cur FROM trucker.quotation_version v WHERE v.quotation_id = q.id AND v.version_no = q.current_version;
  IF cur.amount = c.amount AND cur.inclusions = c.inclusions AND cur.valid_until = c.valid_until
     AND cur.earliest_pickup_at = c.earliest_pickup_at AND cur.notes IS NOT DISTINCT FROM c.notes
     AND NOT q.reconfirmation_needed THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'amount', 'code', 'nothing_changed'));
    RETURN;
  END IF;
  INSERT INTO trucker.quotation_version
    (quotation_id, version_no, kind, amount, currency_code, inclusions,
     valid_until_local, valid_until_offset_minutes, valid_until,
     earliest_pickup_local, earliest_pickup_offset_minutes, earliest_pickup_at, notes,
     shipment_version, created_at, created_by)
  VALUES (q.id, q.current_version + 1, 'revised', c.amount, t.currency_code, c.inclusions,
          c.valid_until_local, c.valid_until_offset_minutes, c.valid_until,
          c.earliest_pickup_local, c.earliest_pickup_offset_minutes, c.earliest_pickup_at, c.notes,
          d.published_version, e.at, e.actor);
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
$$;

-- The current values confirmed for the shipment's newer version (QB-9). A validity that the
-- shipment's new deadline cuts short needs a revision instead.
CREATE FUNCTION trucker.reconfirm_quotation(
  p_quotation uuid, p_expected_version integer, p_key text, p_allow_fixtures boolean,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
     shipment_version, created_at, created_by)
  VALUES (q.id, q.current_version + 1, 'reconfirmed', cur.amount, cur.currency_code, cur.inclusions,
          cur.valid_until_local, cur.valid_until_offset_minutes, cur.valid_until,
          cur.earliest_pickup_local, cur.earliest_pickup_offset_minutes, cur.earliest_pickup_at, cur.notes,
          d.published_version, e.at, e.actor);
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
$$;

-- Withdrawal by its author, at any time while open. No eligibility is needed to withdraw.
--   status: withdrawn | repeated | unauthorized | not_found | not_open | conflict | key_conflict
CREATE FUNCTION trucker.withdraw_quotation(
  p_quotation uuid, p_expected_version integer, p_key text, OUT status text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  q trucker.quotation;
  d trucker.shipment_draft;
  seen record;
  hash text := trucker.content_hash(jsonb_build_object('_v', p_expected_version));
BEGIN
  IF p_quotation IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO e FROM trucker.quotation_carrier_enter(p_quotation);
  status := e.status;
  q := e.q;
  d := e.d;
  IF status NOT IN ('ok', 'not_carrier', 'rate_limited') THEN
    RETURN;
  END IF;
  SELECT * INTO seen FROM trucker.quotation_retry_seen(e.actor, p_key, 'withdraw', hash, e.at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' AND seen.record_id = p_quotation THEN 'repeated' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF q.status <> 'submitted' THEN
    status := 'not_open';
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM q.current_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  UPDATE trucker.quotation x SET status = 'withdrawn', ended_at = e.at, updated_at = e.at WHERE x.id = q.id;
  INSERT INTO trucker.quotation_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (e.actor, p_key, 'withdraw', hash, q.id, e.at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, before_values, after_values)
  VALUES (e.at, e.actor, e.org, 'quotation.withdrawn', 'quotation', q.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('status', 'submitted', 'version', q.current_version),
          jsonb_build_object('status', 'withdrawn'));
  status := 'withdrawn';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The shipper: reject
--   status: rejected | repeated | unauthorized | not_found | not_open | conflict | key_conflict
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.reject_quotation(
  p_quotation uuid, p_expected_version integer, p_key text, OUT status text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  q trucker.quotation;
  v_at timestamptz;
  seen record;
  v_shipment uuid;
  hash text := trucker.content_hash(jsonb_build_object('_v', p_expected_version));
BEGIN
  IF p_quotation IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.organisation o WHERE o.id = v_org FOR SHARE;
  SELECT x.shipment_id INTO v_shipment FROM trucker.quotation x
  WHERE x.id = p_quotation AND x.shipper_organisation_id = v_org;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.shipment_draft x WHERE x.id = v_shipment FOR SHARE;
  SELECT * INTO q FROM trucker.quotation x WHERE x.id = p_quotation FOR UPDATE;
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  PERFORM trucker.quotation_expire_if_due(q.id, v_at);
  SELECT * INTO q FROM trucker.quotation x WHERE x.id = p_quotation;
  SELECT * INTO seen FROM trucker.quotation_retry_seen(actor, p_key, 'reject', hash, v_at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' AND seen.record_id = p_quotation THEN 'repeated' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF q.status <> 'submitted' THEN
    status := 'not_open';
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM q.current_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  UPDATE trucker.quotation x SET status = 'rejected', ended_at = v_at, updated_at = v_at WHERE x.id = q.id;
  INSERT INTO trucker.quotation_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (actor, p_key, 'reject', hash, q.id, v_at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, before_values, after_values)
  VALUES (v_at, actor, v_org, 'quotation.rejected', 'quotation', q.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('status', 'submitted', 'version', q.current_version),
          jsonb_build_object('status', 'rejected'));
  status := 'rejected';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Following the shipment (QB-9, QB-10). In the shipper's own transaction, with the shipment
-- locked by it. Expiry that is due is recorded first.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.quotation_follow_shipment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  q trucker.quotation;
  v_at timestamptz := trucker.clock_now();
  request text := nullif(current_setting('trucker.request_id', true), '');
BEGIN
  PERFORM trucker.quotation_expire_shipment(NEW.id, v_at);
  IF NEW.status = 'withdrawn' AND OLD.status = 'published' THEN
    FOR q IN SELECT * FROM trucker.quotation x WHERE x.shipment_id = NEW.id AND x.status = 'submitted'
             ORDER BY x.id FOR UPDATE LOOP
      UPDATE trucker.quotation x SET status = 'closed', closed_reason = 'shipment_withdrawn',
                                     ended_at = v_at, updated_at = v_at WHERE x.id = q.id;
      INSERT INTO trucker.audit_entry
        (occurred_at, organisation_id, action, record_type, record_id, request_id, before_values, after_values)
      VALUES (v_at, q.carrier_organisation_id, 'quotation.closed', 'quotation', q.id, request,
              jsonb_build_object('status', 'submitted', 'version', q.current_version),
              jsonb_build_object('status', 'closed', 'reason', 'shipment_withdrawn'));
    END LOOP;
  ELSIF NEW.status = 'published' AND NEW.published_version > OLD.published_version THEN
    FOR q IN SELECT * FROM trucker.quotation x WHERE x.shipment_id = NEW.id AND x.status = 'submitted'
             ORDER BY x.id FOR UPDATE LOOP
      UPDATE trucker.quotation x SET reconfirmation_needed = true, updated_at = v_at WHERE x.id = q.id;
      INSERT INTO trucker.audit_entry
        (occurred_at, organisation_id, action, record_type, record_id, request_id, before_values, after_values)
      VALUES (v_at, q.carrier_organisation_id, 'quotation.reconfirmation_required', 'quotation', q.id, request,
              jsonb_build_object('shipmentVersion', OLD.published_version),
              jsonb_build_object('shipmentVersion', NEW.published_version))
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER shipment_quotation_follow AFTER UPDATE OF status, published_version ON trucker.shipment_draft
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.published_version IS DISTINCT FROM NEW.published_version)
  EXECUTE FUNCTION trucker.quotation_follow_shipment();

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

-- The carrier, for one shipment it can discover: the terms and its own quotations on it.
--   status: ok | unauthorized | not_found | not_carrier | rate_limited
CREATE FUNCTION trucker.quotation_context(
  p_shipment uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
    'quotationDeadline', jsonb_build_object('at', d.deadline_at,
                                            'local', to_char(d.deadline_local, 'YYYY-MM-DD"T"HH24:MI'),
                                            'timeZone', d.pickup_time_zone),
    'quotations', coalesce((SELECT jsonb_agg(trucker.quotation_values(q, d, trucker.clock_now(), p_allow_fixtures)
                                             ORDER BY q.created_at DESC, q.id)
                            FROM trucker.quotation q
                            WHERE q.shipment_id = d.id AND q.carrier_organisation_id = entered.org), '[]'::jsonb));
END
$$;

-- The carrier's own quotations, on every shipment, newest first. Each standing is judged live.
--   status: ok | unauthorized | not_found
CREATE FUNCTION trucker.my_quotations(p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  v_at timestamptz;
  one uuid;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.organisation o WHERE o.id = v_org FOR SHARE;
  v_at := trucker.clock_now();
  FOR one IN SELECT q.id FROM trucker.quotation q
             WHERE q.carrier_organisation_id = v_org AND q.status = 'submitted' ORDER BY q.id LOOP
    PERFORM trucker.quotation_expire_if_due(one, v_at);
  END LOOP;
  status := 'ok';
  detail := coalesce((
    SELECT jsonb_agg(x.v ORDER BY x.created_at DESC, x.id)
    FROM (SELECT q.created_at, q.id,
                 trucker.quotation_values(q, d, v_at, p_allow_fixtures)
                   || jsonb_build_object('lane', jsonb_build_object('origin', d.pickup_country,
                                                                    'destination', d.delivery_country)) AS v
          FROM trucker.quotation q JOIN trucker.shipment_draft d ON d.id = q.shipment_id
          WHERE q.carrier_organisation_id = v_org
          ORDER BY q.created_at DESC, q.id LIMIT 200) x), '[]'::jsonb);
END
$$;

-- The shipper, for one of its shipments: the terms, the currencies it may choose and every
-- quotation with the carrier's name (QB-5). Each read is logged.
--   status: ok | unauthorized | not_found
CREATE FUNCTION trucker.shipment_quotations(
  p_shipment uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  d trucker.shipment_draft;
  t trucker.shipment_quotation_terms;
  v_at timestamptz;
  shown uuid[];
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.organisation o WHERE o.id = v_org FOR SHARE;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment AND x.organisation_id = v_org FOR SHARE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  PERFORM trucker.quotation_expire_shipment(d.id, v_at);
  SELECT * INTO t FROM trucker.shipment_quotation_terms x WHERE x.shipment_id = d.id;
  SELECT coalesce(array_agg(q.id ORDER BY q.id), '{}') INTO shown FROM trucker.quotation q WHERE q.shipment_id = d.id;
  INSERT INTO trucker.quotation_read_log (occurred_at, organisation_id, person_id, shipment_id, shown, request_id)
  VALUES (v_at, v_org, actor, d.id, shown, left(nullif(current_setting('trucker.request_id', true), ''), 200));
  status := 'ok';
  detail := jsonb_build_object(
    'terms', CASE WHEN t.shipment_id IS NOT NULL THEN trucker.quotation_terms_values(t) END,
    'currencyChoices', CASE WHEN trucker.quotation_registers_available(p_allow_fixtures) THEN coalesce(
        (SELECT jsonb_agg(jsonb_build_object('code', c.code, 'minorUnits', c.minor_units, 'name', c.name_en)
                          ORDER BY c.code)
         FROM trucker.country_currency cc JOIN trucker.currency c ON c.code = cc.currency_code
         WHERE cc.country_code = d.pickup_country), '[]'::jsonb) ELSE '[]'::jsonb END,
    'inclusionsAvailable', trucker.quotation_registers_available(p_allow_fixtures)
                           AND EXISTS (SELECT 1 FROM trucker.quotation_inclusion),
    'quotations', coalesce((
      SELECT jsonb_agg(trucker.quotation_values(q, d, v_at, p_allow_fixtures) || jsonb_build_object(
               'carrier', jsonb_build_object(
                 'id', o.id, 'legalName', o.legal_name, 'tradingName', o.trading_name,
                 'verified', trucker.capability_effective(o.id, 'carry_as_company')))
             ORDER BY q.created_at, q.id)
      FROM trucker.quotation q JOIN trucker.organisation o ON o.id = q.carrier_organisation_id
      WHERE q.shipment_id = d.id), '[]'::jsonb));
END
$$;

-- Staff, read-only. Reviewers and staff administrators; each look is recorded.
--   status: ok | unauthorized | forbidden | not_found
CREATE FUNCTION trucker.staff_shipment_quotations(
  p_token_hash text, p_shipment uuid, p_request_id text, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.shipment_draft;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, NULL, 'staff.quotation_view', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT (trucker.staff_privileges(entered.staff_id) && ARRAY['reviewer', 'staff_admin']) THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.quotation_view', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'privilege_not_held', 'shipment', p_shipment));
    status := 'forbidden';
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment AND x.published_version IS NOT NULL;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM trucker.quotation_expire_shipment(d.id, entered.at);
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.quotation_view', 'done', NULL, p_request_id,
                              jsonb_build_object('shipment', d.id));
  detail := jsonb_build_object(
    'terms', (SELECT trucker.quotation_terms_values(t) FROM trucker.shipment_quotation_terms t WHERE t.shipment_id = d.id),
    'quotations', coalesce((
      SELECT jsonb_agg(trucker.quotation_values(q, d, entered.at, true) || jsonb_build_object(
               'carrier', jsonb_build_object('id', o.id, 'legalName', o.legal_name)) ORDER BY q.created_at, q.id)
      FROM trucker.quotation q JOIN trucker.organisation o ON o.id = q.carrier_organisation_id
      WHERE q.shipment_id = d.id), '[]'::jsonb));
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may run what.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.set_quotation_terms(uuid, integer, text, jsonb, boolean),
  trucker.submit_quotation(uuid, text, jsonb, boolean),
  trucker.revise_quotation(uuid, integer, text, jsonb, boolean),
  trucker.reconfirm_quotation(uuid, integer, text, boolean),
  trucker.withdraw_quotation(uuid, integer, text),
  trucker.reject_quotation(uuid, integer, text),
  trucker.quotation_context(uuid, boolean),
  trucker.my_quotations(boolean),
  trucker.shipment_quotations(uuid, boolean),
  trucker.staff_shipment_quotations(text, uuid, text)
TO trucker_app;
