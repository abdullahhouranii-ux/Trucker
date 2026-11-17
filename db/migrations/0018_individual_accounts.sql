-- 0018_individual_accounts
-- Individual accounts and truck owners (slice 21, docs/delivery/ACCOUNTS_PHASE_2_SCOPE.md;
-- model: docs/specs/ADR_001_COMMERCIAL_MODEL.md).
--
-- A person may hold one personal account: an organisation of kind 'individual' whose only
-- member is that person. Because it is an organisation, every isolation rule, capability
-- check and history entry already written applies to it unchanged.
--
-- Two capabilities are added, applied for and decided by staff like the others:
--   organise                 coordinator (personal account) or broker (company). In this slice
--                            its holder creates and publishes its own shipments, as a shipper
--                            does. Acting for others comes with shipment roles (slice 22).
--   carry_as_owner_operator  truck owner (personal account only). Works the carrier journey
--                            with the same vehicle, document and driver checks as a company.
--
-- Decisions of 17 November 2026:
--   P2-1  a truck-owner account holds one truck and one trailer, and its owner is its only
--         driver; anyone with more registers as a transport company;
--   P2-2  one personal account may hold both capabilities. That it never quotes on a shipment
--         it organises is already true: no organisation discovers its own shipments (CB-2).
--
-- Every function replaced below is its latest definition (0009, 0010, 0012, 0017) with the
-- changes named beside it. Evidence types for individuals are fictional, like all others.
-- As before: the API's role writes none of this directly, and every function establishes who
-- is asking, takes its locks, reads the database's clock and then decides.

-- ---------------------------------------------------------------------------------------------
-- The kind of account
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.organisation
  ADD COLUMN kind text NOT NULL DEFAULT 'company' CHECK (kind IN ('company', 'individual'));
COMMENT ON COLUMN trucker.organisation.kind IS
  'company, or individual: a personal account with exactly one member. Fixed at creation.';
-- One personal account per person.
CREATE UNIQUE INDEX organisation_one_personal ON trucker.organisation (created_by) WHERE kind = 'individual';
GRANT SELECT (kind) ON trucker.organisation TO trucker_app;

-- A personal account has one member, the person who created it, for good.
CREATE FUNCTION trucker.guard_personal_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  o trucker.organisation;
BEGIN
  SELECT * INTO o FROM trucker.organisation x WHERE x.id = NEW.organisation_id;
  IF o.kind = 'individual'
     AND (NEW.person_id <> o.created_by
          OR EXISTS (SELECT 1 FROM trucker.membership m
                     WHERE m.organisation_id = NEW.organisation_id AND m.id <> NEW.id)) THEN
    RAISE EXCEPTION 'a personal account has one member' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER membership_personal_guard BEFORE INSERT OR UPDATE ON trucker.membership
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_personal_membership();

-- The kind never changes.
CREATE FUNCTION trucker.guard_organisation_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'the kind of an account is fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER organisation_kind_guard BEFORE UPDATE ON trucker.organisation
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_organisation_kind();

-- ---------------------------------------------------------------------------------------------
-- The capabilities
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.organisation
  DROP CONSTRAINT organisation_requested_capability_check,
  ADD CONSTRAINT organisation_requested_capability_check
    CHECK (requested_capability IN ('ship', 'carry_as_company', 'organise', 'carry_as_owner_operator'));
ALTER TABLE trucker.evidence_requirement
  DROP CONSTRAINT evidence_requirement_capability_check,
  ADD CONSTRAINT evidence_requirement_capability_check
    CHECK (capability IN ('ship', 'carry_as_company', 'organise', 'carry_as_owner_operator'));
ALTER TABLE trucker.organisation_capability
  DROP CONSTRAINT organisation_capability_capability_check,
  ADD CONSTRAINT organisation_capability_capability_check
    CHECK (capability IN ('ship', 'carry_as_company', 'organise', 'carry_as_owner_operator'));
ALTER TABLE trucker.verification_application
  DROP CONSTRAINT verification_application_capability_check,
  ADD CONSTRAINT verification_application_capability_check
    CHECK (capability IN ('ship', 'carry_as_company', 'organise', 'carry_as_owner_operator')),
  DROP CONSTRAINT verification_application_revalidates,
  ADD CONSTRAINT verification_application_revalidates CHECK (
    (kind = 'amendment') = (revalidates IS NOT NULL)
    AND (revalidates IS NULL
         OR (cardinality(revalidates) >= 1
             AND revalidates <@ ARRAY['ship', 'carry_as_company', 'organise', 'carry_as_owner_operator'])));

-- Which capability which kind of account may hold.
CREATE FUNCTION trucker.capability_allowed(p_kind text, p_capability text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE p_kind
    WHEN 'company' THEN p_capability IN ('ship', 'carry_as_company', 'organise')
    WHEN 'individual' THEN p_capability IN ('organise', 'carry_as_owner_operator')
    ELSE false END
$$;

-- No capability is ever recorded for a kind of account that may not hold it, whatever path
-- wrote it.
CREATE FUNCTION trucker.guard_capability_kind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF NOT trucker.capability_allowed(
       (SELECT o.kind FROM trucker.organisation o WHERE o.id = NEW.organisation_id), NEW.capability) THEN
    RAISE EXCEPTION 'this kind of account cannot hold this capability' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER organisation_capability_kind_guard BEFORE INSERT OR UPDATE ON trucker.organisation_capability
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_capability_kind();

-- A carrier: a transport company or a truck owner, whichever the account may be.
CREATE FUNCTION trucker.is_carrier(p_organisation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT trucker.capability_effective(p_organisation, 'carry_as_company')
      OR trucker.capability_effective(p_organisation, 'carry_as_owner_operator')
$$;

-- Publishing: a shipper, or an organiser publishing its own shipments.
CREATE OR REPLACE FUNCTION trucker.organisation_publishable(p_organisation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT trucker.capability_effective(p_organisation, 'ship')
      OR trucker.capability_effective(p_organisation, 'organise')
$$;
CREATE OR REPLACE FUNCTION trucker.organisation_may_publish() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT trucker.organisation_publishable(trucker.request_organisation())
$$;

-- The declared service in force, for either kind of carrier.
CREATE OR REPLACE FUNCTION trucker.carrier_service(p_organisation uuid, OUT countries text[], OUT equipment text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT
    coalesce((SELECT array_agg(s.country_code ORDER BY s.country_code)
              FROM trucker.carrier_service_country s WHERE s.application_id = c.granted_application), '{}'),
    coalesce((SELECT array_agg(s.equipment_type ORDER BY s.equipment_type)
              FROM trucker.carrier_service_equipment s WHERE s.application_id = c.granted_application), '{}')
  FROM (SELECT 1 AS one) x
  LEFT JOIN trucker.organisation_capability c
    ON c.organisation_id = p_organisation
   AND c.capability IN ('carry_as_company', 'carry_as_owner_operator') AND c.status = 'granted'
$$;

-- ---------------------------------------------------------------------------------------------
-- Creating a personal account. Like create_organisation (0004), except: the kind, one per
-- person, and no trading name or contact person.
--   TR001 registration is not complete; TR003 the country is not open; TR004 the person
--   already has a personal account.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.create_personal_account(
  p_legal_name text, p_country_code text, p_registration_number text, p_address text,
  p_allow_fixtures boolean
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  actor uuid := trucker.request_person();
  t timestamptz;
  new_row trucker.organisation;
  environment_kind text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'no signed-in person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trucker.person
                 WHERE id = actor AND registration_completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'registration is not complete' USING ERRCODE = 'TR001';
  END IF;
  -- The same lock as creating an organisation: one creation at a time per person.
  PERFORM pg_advisory_xact_lock(hashtextextended('organisation.create:' || actor::text, 0));
  IF trucker.request_person() IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'no signed-in person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  t := trucker.clock_now();
  IF EXISTS (SELECT 1 FROM trucker.organisation o WHERE o.created_by = actor AND o.kind = 'individual') THEN
    RAISE EXCEPTION 'a personal account exists' USING ERRCODE = 'TR004';
  END IF;
  SELECT e.kind INTO environment_kind FROM trucker.environment e;
  IF NOT EXISTS (
    SELECT 1 FROM trucker.country c
    WHERE c.code = p_country_code
      AND c.registration_state = 'enabled'
      AND (NOT c.fixture
           OR (coalesce(p_allow_fixtures, false) AND environment_kind IN ('local-development', 'test')))) THEN
    RAISE EXCEPTION 'country is not open for registration' USING ERRCODE = 'TR003';
  END IF;
  INSERT INTO trucker.organisation
    (kind, requested_capability, legal_name, country_code, registration_number, address,
     created_by, created_at, updated_at)
  VALUES
    ('individual', 'organise', p_legal_name, p_country_code, p_registration_number, p_address, actor, t, t)
  RETURNING * INTO new_row;
  INSERT INTO trucker.membership (organisation_id, person_id, role, created_at)
  VALUES (new_row.id, actor, 'admin', t);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES
    (t, actor, new_row.id, 'organisation.created', 'organisation', new_row.id,
     nullif(current_setting('trucker.request_id', true), ''),
     NULL, trucker.organisation_values(new_row) || jsonb_build_object('kind', 'individual'));
  RETURN new_row.id;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Carrier checks: "a carrier" now means a transport company or a truck owner. Each function
-- is unchanged except that trucker.capability_effective(x, 'carry_as_company') reads
-- trucker.is_carrier(x). shipment_quotations also tells the shipper which kind of account
-- each carrier is (accountKind).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.booking_detail(p_booking uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  b trucker.booking;
  v_at timestamptz;
  v_role text;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x
  WHERE x.id = p_booking AND v_org IN (x.shipper_organisation_id, x.carrier_organisation_id);
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  PERFORM trucker.overrun_note(v_at);
  v_role := CASE WHEN b.shipper_organisation_id = v_org THEN 'shipper' ELSE 'carrier' END;
  status := 'ok';
  detail := jsonb_build_object(
    'open', trucker.booking_terms_available(p_allow_fixtures),
    'booking', trucker.booking_view(b, v_role, v_at) || jsonb_build_object('role', v_role),
    'candidates', CASE WHEN NOT EXISTS (SELECT 1 FROM trucker.booking_cancellation z WHERE z.booking_id=b.id) AND v_role = 'carrier' AND trucker.is_carrier(v_org)
                       THEN trucker.assignment_candidates(b, v_at) END);
END
$$;

CREATE OR REPLACE FUNCTION trucker.discovery_enter(OUT status text, OUT actor uuid, OUT org uuid, OUT at timestamp with time zone, OUT countries text[], OUT equipment text[])
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  g trucker.security_setting;
BEGIN
  actor := trucker.request_person();
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  org := trucker.request_organisation();
  IF org IS NULL OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  -- Staff revocations and decisions lock the organisation first: a request waiting here
  -- proceeds only after they have committed, and judges by what they left.
  PERFORM 1 FROM trucker.organisation o WHERE o.id = org FOR SHARE;
  IF trucker.request_person() IS DISTINCT FROM actor THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  at := trucker.clock_now();
  IF NOT trucker.is_carrier(org) THEN
    status := 'not_carrier';
    RETURN;
  END IF;
  SELECT * INTO g FROM trucker.security_setting;
  IF (SELECT count(*) FROM trucker.carrier_access_log l
      WHERE l.organisation_id = org AND l.occurred_at > at - interval '60 seconds') >= g.discovery_read_limit THEN
    status := 'rate_limited';
    RETURN;
  END IF;
  SELECT s.countries, s.equipment INTO countries, equipment FROM trucker.carrier_service(org) s;
  status := 'ok';
END
$$;

CREATE OR REPLACE FUNCTION trucker.discovery_status(OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  org uuid := trucker.request_organisation();
  s record;
BEGIN
  IF trucker.request_person() IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF org IS NULL OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO s FROM trucker.carrier_service(org);
  status := CASE WHEN trucker.is_carrier(org) THEN 'ok' ELSE 'not_carrier' END;
  detail := jsonb_build_object('kind', 'declared_matching_criteria',
                               'countries', to_jsonb(s.countries), 'equipmentTypes', to_jsonb(s.equipment));
END
$$;

CREATE OR REPLACE FUNCTION trucker.driver_eligibility(p_affiliation uuid, p_vehicle uuid, p_from timestamp with time zone, p_until timestamp with time zone)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  a trucker.driver_affiliation;
  v trucker.vehicle;
  v_country text;
  v_documents text;
BEGIN
  IF p_from IS NULL OR p_until IS NULL OR p_until < p_from THEN
    RAISE EXCEPTION 'invalid window' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO a FROM trucker.driver_affiliation x WHERE x.id = p_affiliation AND x.status = 'active';
  IF NOT FOUND THEN
    RETURN 'not_affiliated';
  END IF;
  IF NOT trucker.is_carrier(a.organisation_id) THEN
    RETURN 'carrier_not_eligible';
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.fleet_suspension s WHERE s.person_id = a.person_id AND s.ended_at IS NULL) THEN
    RETURN 'suspended';
  END IF;
  SELECT o.country_code INTO v_country FROM trucker.organisation o WHERE o.id = a.organisation_id;
  v_documents := trucker.fleet_documents_cover(a.person_id, v_country, 'driver', p_from, p_until);
  IF v_documents IS NOT NULL THEN
    RETURN v_documents;
  END IF;
  IF p_vehicle IS NOT NULL THEN
    SELECT * INTO v FROM trucker.vehicle x
    WHERE x.id = p_vehicle AND x.organisation_id = a.organisation_id AND x.status = 'active';
    IF NOT FOUND THEN
      RETURN 'vehicle_not_found';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trucker.driver_authorisation z
                   WHERE z.affiliation_id = a.id AND z.status = 'active'
                     AND (z.vehicle_id IS NULL OR z.vehicle_id = v.id)) THEN
      RETURN 'not_authorised';
    END IF;
    -- A licence class on an accepted licence that is valid through the window covers the category.
    IF NOT EXISTS (
         SELECT 1
         FROM trucker.fleet_document d
         JOIN trucker.fleet_document_type t
           ON t.country_code = d.country_code AND t.subject_kind = d.type_kind AND t.code = d.type_code
         JOIN trucker.licence_class_category m
           ON m.country_code = d.country_code AND m.class_code = ANY (d.licence_classes)
         WHERE d.person_id = a.person_id AND d.country_code = v_country AND d.status = 'accepted'
           AND t.carries_licence AND m.category_code = v.category_code
           AND trucker.fleet_document_valid_until(d) >= p_until) THEN
      RETURN 'licence_class_not_covering';
    END IF;
  END IF;
  RETURN 'eligible';
END
$$;

CREATE OR REPLACE FUNCTION trucker.fleet_carrier_enter(OUT status text, OUT actor uuid, OUT org uuid, OUT at timestamp with time zone)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
BEGIN
  actor := trucker.request_person();
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  org := trucker.request_organisation();
  IF org IS NULL OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.organisation o WHERE o.id = org FOR SHARE;
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  at := trucker.clock_now();
  status := CASE WHEN trucker.is_carrier(org) THEN 'ok' ELSE 'not_carrier' END;
END
$$;

CREATE OR REPLACE FUNCTION trucker.quotation_standing(q trucker.quotation, d trucker.shipment_draft, p_at timestamp with time zone, p_allow_fixtures boolean)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
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
  IF NOT trucker.is_carrier(q.carrier_organisation_id)
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

CREATE OR REPLACE FUNCTION trucker.shipment_quotations(p_shipment uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
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
                 'verified', trucker.is_carrier(o.id), 'accountKind', o.kind))
             ORDER BY q.created_at, q.id)
      FROM trucker.quotation q JOIN trucker.organisation o ON o.id = q.carrier_organisation_id
      WHERE q.shipment_id = d.id), '[]'::jsonb));
END
$$;

CREATE OR REPLACE FUNCTION trucker.vehicle_eligibility(p_vehicle uuid, p_organisation uuid, p_from timestamp with time zone, p_until timestamp with time zone, p_equipment text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  v trucker.vehicle;
  v_documents text;
BEGIN
  IF p_from IS NULL OR p_until IS NULL OR p_until < p_from THEN
    RAISE EXCEPTION 'invalid window' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v FROM trucker.vehicle x WHERE x.id = p_vehicle AND x.status = 'active';
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF NOT trucker.is_carrier(v.organisation_id) THEN
    RETURN 'carrier_not_eligible';
  END IF;
  IF v.ownership <> 'verified' THEN
    RETURN 'ownership_not_verified';
  END IF;
  IF trucker.vehicle_operating_controller(v.id) IS DISTINCT FROM p_organisation THEN
    RETURN 'not_operating_controller';
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.fleet_suspension s WHERE s.vehicle_id = v.id AND s.ended_at IS NULL) THEN
    RETURN 'suspended';
  END IF;
  v_documents := trucker.fleet_documents_cover(v.id, v.registration_country, v.kind, p_from, p_until);
  IF v_documents IS NOT NULL THEN
    RETURN v_documents;
  END IF;
  IF p_equipment IS NOT NULL AND p_equipment <> v.equipment_type THEN
    RETURN 'equipment_mismatch';
  END IF;
  RETURN 'eligible';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Submission (replaces 0009's). The changes: the two new capabilities; a capability must be
-- one the kind of account may hold (not_for_account_kind); a truck owner declares its service
-- as a company carrier does; "already granted" covers organise as it does ship.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.submit_verification(p_key text, p_expected_version integer, p_content jsonb, p_allow_fixtures boolean, OUT status text, OUT application_id uuid, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org_id uuid;
  org trucker.organisation;
  g trucker.security_setting;
  t timestamptz;
  hash text;
  earlier trucker.verification_retry_key;
  v_kind text;
  v_capability text;
  v_capabilities text[];
  v_name text;
  v_country text;
  v_number text;
  v_countries text[] := '{}';
  v_equipment text[] := '{}';
  held_countries text[];
  held_equipment text[];
  v_carry_from uuid;
  v_code text;
  problems jsonb := '[]'::jsonb;
  entry jsonb;
  seen text[] := '{}';
  v_type text;
  v_issued date;
  v_expires date;
  made trucker.verification_application;
  next_no integer;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  org_id := trucker.request_organisation();
  IF org_id IS NULL OR NOT trucker.is_admin(org_id) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO org FROM trucker.organisation o WHERE o.id = org_id FOR UPDATE;
  IF trucker.request_person() IS DISTINCT FROM actor THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF NOT trucker.is_admin(org_id) THEN
    status := 'not_found';
    RETURN;
  END IF;
  t := trucker.clock_now();
  SELECT * INTO g FROM trucker.security_setting;
  hash := trucker.content_hash(p_content);

  SELECT * INTO earlier FROM trucker.verification_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  IF FOUND AND earlier.created_at > t - make_interval(hours => g.retry_key_retention_hours) THEN
    IF earlier.operation <> 'submit' OR earlier.request_hash <> hash
       OR NOT EXISTS (SELECT 1 FROM trucker.verification_application a
                      WHERE a.id = earlier.application_id AND a.organisation_id = org_id) THEN
      status := 'key_conflict';
      RETURN;
    END IF;
    status := 'repeated';
    application_id := earlier.application_id;
    RETURN;
  END IF;
  IF FOUND THEN
    DELETE FROM trucker.verification_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  END IF;

  IF p_expected_version IS DISTINCT FROM org.version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF org.status NOT IN ('draft', 'changes_requested', 'rejected', 'verification_withdrawn', 'verified')
     OR EXISTS (SELECT 1 FROM trucker.verification_application a
                WHERE a.organisation_id = org_id AND a.status IN ('submitted', 'claim_review')) THEN
    status := 'not_open';
    RETURN;
  END IF;

  IF org.status = 'verified' AND p_content ? 'proposed' THEN
    -- An amendment of the shared identity: it revalidates every capability held now.
    v_kind := 'amendment';
    SELECT array_agg(c.capability ORDER BY c.capability) INTO v_capabilities
    FROM trucker.organisation_capability c WHERE c.organisation_id = org_id AND c.status = 'granted';
    IF v_capabilities IS NULL THEN
      status := 'not_open';
      RETURN;
    END IF;
    v_capability := v_capabilities[1];
    IF p_content ? 'service' OR p_content ? 'capability' THEN
      problems := problems || jsonb_build_object('field', 'proposed', 'code', 'amendment_only');
    END IF;
    v_name := btrim(coalesce(p_content #>> '{proposed,legalName}', ''));
    v_country := coalesce(p_content #>> '{proposed,countryCode}', '');
    v_number := btrim(coalesce(p_content #>> '{proposed,registrationNumber}', ''));
    IF length(v_name) NOT BETWEEN 1 AND 200 THEN
      problems := problems || jsonb_build_object('field', 'proposed.legalName', 'code', 'required');
    END IF;
    IF length(v_number) NOT BETWEEN 1 AND 60 THEN
      problems := problems || jsonb_build_object('field', 'proposed.registrationNumber', 'code', 'required');
    END IF;
    IF NOT trucker.country_available(v_country, p_allow_fixtures) THEN
      problems := problems || jsonb_build_object('field', 'proposed.countryCode', 'code', 'country_unavailable');
    END IF;
    IF problems = '[]'::jsonb AND v_name = org.legal_name AND v_country = org.country_code
       AND v_number = org.registration_number THEN
      problems := problems || jsonb_build_object('field', 'proposed.legalName', 'code', 'nothing_changed');
    END IF;
    -- The declared service in force is carried forward unchanged.
    IF v_capabilities && ARRAY['carry_as_company', 'carry_as_owner_operator'] THEN
      SELECT c.granted_application INTO v_carry_from FROM trucker.organisation_capability c
      WHERE c.organisation_id = org_id AND c.capability IN ('carry_as_company', 'carry_as_owner_operator') AND c.status = 'granted';
    END IF;
  ELSE
    v_capability := coalesce(p_content ->> 'capability', org.requested_capability);
    IF v_capability NOT IN ('ship', 'carry_as_company', 'organise', 'carry_as_owner_operator') THEN
      problems := problems || jsonb_build_object('field', 'capability', 'code', 'invalid');
      v_capability := org.requested_capability;
    ELSIF NOT trucker.capability_allowed(org.kind, v_capability) THEN
      -- A company never carries as an owner-operator; a personal account never ships or
      -- carries as a company.
      problems := problems || jsonb_build_object('field', 'capability', 'code', 'not_for_account_kind');
    END IF;
    v_capabilities := ARRAY[v_capability];
    v_name := org.legal_name;
    v_country := org.country_code;
    v_number := org.registration_number;
    IF org.status = 'verified' THEN
      v_kind := 'capability';
      IF v_capability IN ('ship', 'organise') AND EXISTS (
           SELECT 1 FROM trucker.organisation_capability c
           WHERE c.organisation_id = org_id AND c.capability = v_capability AND c.status = 'granted') THEN
        problems := problems || jsonb_build_object('field', 'capability', 'code', 'already_granted');
      END IF;
    ELSE
      v_kind := 'initial';
    END IF;
    IF NOT trucker.country_available(v_country, p_allow_fixtures) THEN
      status := 'closed';
      RETURN;
    END IF;
    IF p_content ? 'service' AND v_capability NOT IN ('carry_as_company', 'carry_as_owner_operator') THEN
      problems := problems || jsonb_build_object('field', 'service', 'code', 'carrier_only');
    END IF;
    IF v_capability IN ('carry_as_company', 'carry_as_owner_operator') THEN
      -- The declared service: at least one country and one equipment type, each from the
      -- registers this request may use. Matching criteria only.
      IF jsonb_typeof(p_content #> '{service,countries}') IS DISTINCT FROM 'array'
         OR jsonb_array_length(p_content #> '{service,countries}') NOT BETWEEN 1 AND 30 THEN
        problems := problems || jsonb_build_object('field', 'service.countries', 'code', 'required');
      ELSE
        FOR v_code IN SELECT jsonb_array_elements_text(p_content #> '{service,countries}') LOOP
          IF NOT trucker.country_available(v_code, p_allow_fixtures) OR v_code = ANY (v_countries) THEN
            problems := problems || jsonb_build_object('field', 'service.countries', 'code', 'country_unavailable');
            CONTINUE;
          END IF;
          v_countries := v_countries || v_code;
        END LOOP;
      END IF;
      IF jsonb_typeof(p_content #> '{service,equipmentTypes}') IS DISTINCT FROM 'array'
         OR jsonb_array_length(p_content #> '{service,equipmentTypes}') NOT BETWEEN 1 AND 30 THEN
        problems := problems || jsonb_build_object('field', 'service.equipmentTypes', 'code', 'required');
      ELSE
        FOR v_code IN SELECT jsonb_array_elements_text(p_content #> '{service,equipmentTypes}') LOOP
          IF NOT EXISTS (SELECT 1 FROM trucker.equipment_type e WHERE e.code = v_code)
             OR NOT trucker.catalogue_available(p_allow_fixtures) OR v_code = ANY (v_equipment) THEN
            problems := problems || jsonb_build_object('field', 'service.equipmentTypes', 'code', 'unknown');
            CONTINUE;
          END IF;
          v_equipment := v_equipment || v_code;
        END LOOP;
      END IF;
      -- Asking again for the service already in force changes nothing.
      IF v_kind = 'capability' AND problems = '[]'::jsonb THEN
        SELECT s.countries, s.equipment INTO held_countries, held_equipment FROM trucker.carrier_service(org_id) s;
        IF EXISTS (SELECT 1 FROM trucker.organisation_capability c
                   WHERE c.organisation_id = org_id AND c.capability = v_capability AND c.status = 'granted')
           AND held_countries = (SELECT array_agg(x ORDER BY x) FROM unnest(v_countries) x)
           AND held_equipment = (SELECT array_agg(x ORDER BY x) FROM unnest(v_equipment) x) THEN
          problems := problems || jsonb_build_object('field', 'service.countries', 'code', 'nothing_changed');
        END IF;
      END IF;
    END IF;
  END IF;

  -- Nothing can be verified where no requirement exists, for any capability asked for.
  IF problems = '[]'::jsonb AND EXISTS (
       SELECT 1 FROM unnest(v_capabilities) cap
       WHERE NOT EXISTS (SELECT 1 FROM trucker.evidence_requirement r
                         WHERE r.country_code = v_country AND r.capability = cap)) THEN
    status := 'closed';
    RETURN;
  END IF;

  IF (p_content #>> '{declaration,accepted}') IS DISTINCT FROM 'true' THEN
    problems := problems || jsonb_build_object('field', 'declaration', 'code', 'required');
  END IF;
  IF coalesce(p_content #>> '{declaration,language}', '') NOT IN ('en', 'ar', 'ur')
     OR length(coalesce(p_content #>> '{declaration,version}', '')) NOT BETWEEN 1 AND 40 THEN
    problems := problems || jsonb_build_object('field', 'declaration', 'code', 'invalid');
  END IF;

  IF jsonb_typeof(p_content -> 'evidence') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_content -> 'evidence') > 20 THEN
    problems := problems || jsonb_build_object('field', 'evidence', 'code', 'invalid');
  ELSE
    FOR entry IN SELECT * FROM jsonb_array_elements(p_content -> 'evidence') LOOP
      v_type := coalesce(entry ->> 'documentType', '');
      IF NOT EXISTS (SELECT 1 FROM trucker.application_requirements(v_country, v_capabilities) r
                     WHERE r.document_type = v_type) OR v_type = ANY (seen) THEN
        problems := problems || jsonb_build_object('field', 'evidence', 'code', 'invalid');
        CONTINUE;
      END IF;
      seen := seen || v_type;
      IF length(btrim(coalesce(entry ->> 'documentNumber', ''))) NOT BETWEEN 1 AND 80 THEN
        problems := problems || jsonb_build_object('field', 'evidence.' || v_type || '.documentNumber', 'code', 'required');
      END IF;
      IF NOT trucker.country_available(coalesce(entry ->> 'issuingCountry', ''), p_allow_fixtures) THEN
        problems := problems || jsonb_build_object('field', 'evidence.' || v_type || '.issuingCountry', 'code', 'country_unavailable');
      END IF;
      BEGIN
        v_issued := nullif(entry ->> 'issuedOn', '')::date;
        v_expires := nullif(entry ->> 'expiresOn', '')::date;
        IF coalesce(entry ->> 'issuedOn', '') !~ '^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           OR coalesce(entry ->> 'expiresOn', '') !~ '^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
          RAISE EXCEPTION 'not a date';
        END IF;
        IF v_issued IS NOT NULL AND v_issued > (t AT TIME ZONE 'UTC')::date + 1 THEN
          problems := problems || jsonb_build_object('field', 'evidence.' || v_type || '.issuedOn', 'code', 'date_in_future');
        END IF;
        IF v_expires IS NOT NULL AND v_issued IS NOT NULL AND v_expires <= v_issued THEN
          problems := problems || jsonb_build_object('field', 'evidence.' || v_type || '.expiresOn', 'code', 'date_order');
        END IF;
      EXCEPTION WHEN others THEN
        problems := problems || jsonb_build_object('field', 'evidence.' || v_type || '.issuedOn', 'code', 'date_invalid');
      END;
    END LOOP;
    FOR v_type IN
      SELECT r.document_type FROM trucker.application_requirements(v_country, v_capabilities) r
      WHERE r.required ORDER BY r.ord, r.document_type
    LOOP
      IF NOT (v_type = ANY (seen)) THEN
        problems := problems || jsonb_build_object('field', 'evidence.' || v_type || '.documentNumber', 'code', 'required');
      END IF;
    END LOOP;
  END IF;

  IF problems <> '[]'::jsonb THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;

  SELECT coalesce(max(a.version_no), 0) + 1 INTO next_no
  FROM trucker.verification_application a WHERE a.organisation_id = org_id;
  INSERT INTO trucker.verification_application
    (organisation_id, version_no, kind, status, legal_name, country_code, registration_number,
     capability, revalidates, previous_status, submitted_by, submitted_at,
     declaration_kind, declaration_version, declaration_language)
  VALUES
    (org_id, next_no, v_kind, 'submitted', v_name, v_country, v_number,
     v_capability, CASE WHEN v_kind = 'amendment' THEN v_capabilities END, org.status, actor, t,
     'demonstration', p_content #>> '{declaration,version}', p_content #>> '{declaration,language}')
  RETURNING * INTO made;
  INSERT INTO trucker.verification_evidence
    (application_id, document_type, document_number, issuing_country, issued_on, expires_on)
  SELECT made.id, e ->> 'documentType', btrim(e ->> 'documentNumber'), e ->> 'issuingCountry',
         nullif(e ->> 'issuedOn', '')::date, nullif(e ->> 'expiresOn', '')::date
  FROM jsonb_array_elements(p_content -> 'evidence') e;
  IF v_carry_from IS NOT NULL THEN
    INSERT INTO trucker.carrier_service_country (application_id, country_code)
    SELECT made.id, s.country_code FROM trucker.carrier_service_country s WHERE s.application_id = v_carry_from;
    INSERT INTO trucker.carrier_service_equipment (application_id, equipment_type)
    SELECT made.id, s.equipment_type FROM trucker.carrier_service_equipment s WHERE s.application_id = v_carry_from;
  ELSIF v_capability IN ('carry_as_company', 'carry_as_owner_operator') AND v_kind <> 'amendment' THEN
    INSERT INTO trucker.carrier_service_country (application_id, country_code)
    SELECT made.id, x FROM unnest(v_countries) x;
    INSERT INTO trucker.carrier_service_equipment (application_id, equipment_type)
    SELECT made.id, x FROM unnest(v_equipment) x;
  END IF;
  IF v_kind = 'initial' THEN
    UPDATE trucker.organisation o SET status = 'submitted', version = o.version + 1 WHERE o.id = org_id;
  END IF;
  INSERT INTO trucker.verification_retry_key (person_id, key, operation, request_hash, application_id, created_at)
  VALUES (actor, p_key, 'submit', hash, made.id, t);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES
    (t, actor, org_id, 'verification.submitted', 'verification_application', made.id,
     nullif(current_setting('trucker.request_id', true), ''), NULL, trucker.application_values(made));
  status := 'submitted';
  application_id := made.id;
END
$$;

-- Revocation (replaces 0009's): accepts the two new capabilities.
CREATE OR REPLACE FUNCTION trucker.staff_verification_revoke(p_token_hash text, p_organisation uuid, p_capability text, p_reason text, p_note text, p_no_conflict boolean, p_request_id text, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  entered record;
  org trucker.organisation;
  held trucker.organisation_capability;
  granted trucker.verification_application;
  open_one trucker.verification_application;
  independence text;
  remaining integer;
  note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  SELECT * INTO open_one FROM trucker.verification_application a
  WHERE a.organisation_id = p_organisation AND a.status IN ('submitted', 'claim_review') FOR UPDATE;
  SELECT * INTO org FROM trucker.organisation o WHERE o.id = p_organisation FOR UPDATE;
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.verification_revoke', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF org.id IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_capability IS NULL OR p_capability NOT IN ('ship', 'carry_as_company', 'organise', 'carry_as_owner_operator')
     OR p_reason IS NULL OR p_reason NOT IN ('verified_in_error', 'information_changed', 'other')
     OR (note IS NOT NULL AND length(note) > 1000) OR (p_reason = 'other' AND note IS NULL) THEN
    status := 'invalid';
    RETURN;
  END IF;
  SELECT * INTO held FROM trucker.organisation_capability c
  WHERE c.organisation_id = org.id AND c.capability = p_capability FOR UPDATE;
  IF org.status <> 'verified' OR NOT FOUND OR held.status <> 'granted' THEN
    IF FOUND AND held.status = 'revoked' AND held.revoked_by = entered.staff_id
       AND held.revoke_reason = p_reason THEN
      status := 'repeated';
    ELSE
      status := 'not_verified';
    END IF;
    RETURN;
  END IF;
  SELECT * INTO granted FROM trucker.verification_application a WHERE a.id = held.granted_application;
  IF granted.decided_by = entered.staff_id THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_revoke', 'refused', NULL,
                                p_request_id,
                                jsonb_build_object('organisation', org.id, 'capability', p_capability,
                                                   'reason', 'gave_the_verification'));
    status := 'same_person';
    RETURN;
  END IF;
  independence := trucker.reviewer_independence(entered.staff_id, org.id, granted.submitted_by, p_no_conflict);
  IF independence <> 'ok' THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_revoke', 'refused', NULL,
                                p_request_id,
                                jsonb_build_object('organisation', org.id, 'capability', p_capability,
                                                   'reason', independence));
    status := 'not_independent';
    detail := jsonb_build_object('reason', independence);
    RETURN;
  END IF;

  PERFORM set_config('trucker.acting_staff', entered.staff_id::text, true);
  UPDATE trucker.organisation_capability c
  SET status = 'revoked', revoked_at = entered.at, revoked_by = entered.staff_id,
      revoke_reason = p_reason, revoke_note = note
  WHERE c.organisation_id = org.id AND c.capability = p_capability;
  SELECT count(*) INTO remaining FROM trucker.organisation_capability c
  WHERE c.organisation_id = org.id AND c.status = 'granted';
  IF remaining = 0 THEN
    UPDATE trucker.organisation o SET status = 'verification_withdrawn', version = o.version + 1
    WHERE o.id = org.id;
    IF open_one.id IS NOT NULL THEN
      UPDATE trucker.verification_application a
      SET status = 'withdrawn', withdrawn_at = entered.at, row_version = a.row_version + 1
      WHERE a.id = open_one.id;
    END IF;
  END IF;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_staff_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES (entered.at, entered.staff_id, org.id, 'verification.revoked', 'verification_application',
          granted.id, left(p_request_id, 200),
          jsonb_build_object('capability', p_capability, 'status', 'granted'),
          jsonb_build_object('capability', p_capability, 'status', 'revoked', 'reason', p_reason,
                             'organisationStatus', CASE WHEN remaining = 0 THEN 'verification_withdrawn'
                                                        ELSE 'verified' END));
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_revoke', 'done', NULL,
                              p_request_id,
                              jsonb_build_object('organisation', org.id, 'capability', p_capability,
                                                 'reason', p_reason, 'no_conflict_declared', true));
  status := 'revoked';
END
$$;

-- One application for staff (replaces 0009's): also the kind of account.
CREATE OR REPLACE FUNCTION trucker.staff_verification_view(p_token_hash text, p_application uuid, p_request_id text, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  entered record;
  app trucker.verification_application;
  org trucker.organisation;
  caps text[];
BEGIN
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'reviewer', 'staff.verification_view', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO app FROM trucker.verification_application a WHERE a.id = p_application;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO org FROM trucker.organisation o WHERE o.id = app.organisation_id;
  caps := coalesce(app.revalidates, ARRAY[app.capability]);
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_view', 'done', NULL, p_request_id,
                              jsonb_build_object('application', app.id, 'organisation', org.id));
  detail := jsonb_build_object(
    'application', trucker.application_values(app) || jsonb_build_object(
      'id', app.id, 'rowVersion', app.row_version, 'submittedAt', app.submitted_at,
      'decidedAt', app.decided_at, 'decisionNote', app.decision_note,
      'declarationKind', app.declaration_kind, 'declarationVersion', app.declaration_version,
      'declarationLanguage', app.declaration_language,
      'claimRaised', app.claim_raised_by IS NOT NULL,
      'claimRaisedByCaller', app.claim_raised_by IS NOT DISTINCT FROM entered.staff_id),
    'organisation', jsonb_build_object(
      'id', org.id, 'kind', org.kind, 'status', org.status, 'legalName', org.legal_name, 'tradingName', org.trading_name,
      'countryCode', org.country_code, 'registrationNumber', org.registration_number,
      'address', org.address, 'contactName', org.contact_name, 'createdAt', org.created_at,
      -- 0007's single capability, kept for the shipper capability.
      'capability', (SELECT jsonb_build_object('status', c.status, 'basis', c.basis, 'grantedAt', c.granted_at,
                                               'grantedByCaller', gr.decided_by IS NOT DISTINCT FROM entered.staff_id)
                     FROM trucker.organisation_capability c
                     JOIN trucker.verification_application gr ON gr.id = c.granted_application
                     WHERE c.organisation_id = org.id AND c.capability = 'ship'),
      'capabilities', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'capability', c.capability, 'status', c.status, 'basis', c.basis, 'grantedAt', c.granted_at,
          'effective', trucker.capability_effective(org.id, c.capability),
          'grantedByCaller', gr.decided_by IS NOT DISTINCT FROM entered.staff_id,
          'service', trucker.application_service(c.granted_application)) ORDER BY c.capability)
        FROM trucker.organisation_capability c
        JOIN trucker.verification_application gr ON gr.id = c.granted_application
        WHERE c.organisation_id = org.id), '[]'::jsonb)),
    'requirements', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'documentType', r.document_type,
        'name', (SELECT x.name_en FROM trucker.evidence_requirement x
                 WHERE x.country_code = app.country_code AND x.document_type = r.document_type
                   AND x.capability = ANY (caps) ORDER BY x.capability LIMIT 1),
        'required', r.required)
        ORDER BY r.ord, r.document_type)
      FROM trucker.application_requirements(app.country_code, caps) r), '[]'::jsonb),
    'earlier', coalesce((SELECT jsonb_agg(trucker.application_values(v) || jsonb_build_object(
        'id', v.id, 'submittedAt', v.submitted_at, 'decidedAt', v.decided_at, 'decisionNote', v.decision_note)
        ORDER BY v.version_no DESC)
      FROM trucker.verification_application v
      WHERE v.organisation_id = org.id AND v.id <> app.id), '[]'::jsonb),
    'competing', EXISTS (
      SELECT 1 FROM trucker.organisation o
      WHERE o.id <> org.id AND o.status = 'verified'
        AND trucker.registration_key(o.country_code, o.registration_number)
            = trucker.registration_key(app.country_code, app.registration_number)),
    'independence', trucker.reviewer_independence(entered.staff_id, org.id, app.submitted_by, true));
END
$$;

-- The queue for staff, with the kind of account.
DROP FUNCTION trucker.staff_verification_queue(text);
CREATE FUNCTION trucker.staff_verification_queue(p_token_hash text)
RETURNS TABLE (
  application_id uuid, organisation_id uuid, version_no integer, kind text, status text,
  legal_name text, country_code text, submitted_at timestamptz, capability text, revalidates text[],
  account_kind text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT a.id, a.organisation_id, a.version_no, a.kind, a.status, a.legal_name, a.country_code,
         a.submitted_at, a.capability, a.revalidates, o.kind
  FROM trucker.staff_live_session(p_token_hash) l
  JOIN trucker.verification_application a ON 'reviewer' = ANY (trucker.staff_privileges(l.staff_id))
  JOIN trucker.organisation o ON o.id = a.organisation_id
  WHERE a.status IN ('submitted', 'claim_review')
  ORDER BY a.submitted_at, a.id
  LIMIT 200
$$;

-- ---------------------------------------------------------------------------------------------
-- The fleet of a truck owner (P2-1)
-- ---------------------------------------------------------------------------------------------
-- Registering a vehicle (replaces 0012's): a truck-owner account holds one active truck and
-- one active trailer (owner_limit).
CREATE OR REPLACE FUNCTION trucker.register_vehicle(p_key text, p_content jsonb, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  v trucker.vehicle;
  problems jsonb := '[]'::jsonb;
  v_kind text := p_content ->> 'kind';
  v_number text := upper(regexp_replace(coalesce(p_content ->> 'registrationNumber', ''), '[\s-]', '', 'g'));
  hash text := trucker.content_hash(coalesce(p_content, 'null'::jsonb));
BEGIN
  SELECT * INTO entered FROM trucker.fleet_carrier_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO seen FROM trucker.fleet_retry_seen(entered.actor, p_key, 'vehicle', hash, entered.at);
  IF seen.seen IS NOT NULL THEN
    SELECT * INTO v FROM trucker.vehicle x WHERE x.id = seen.record_id AND x.organisation_id = entered.org;
    IF seen.seen = 'repeated' AND FOUND THEN
      status := 'repeated';
      detail := trucker.vehicle_values(v, entered.at);
    ELSE
      status := 'key_conflict';
    END IF;
    RETURN;
  END IF;
  IF NOT trucker.fleet_registers_available(p_allow_fixtures) THEN
    status := 'closed';
    RETURN;
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('truck', 'trailer') THEN
    problems := problems || jsonb_build_object('field', 'kind', 'code', 'required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trucker.vehicle_category c
                 WHERE c.code = p_content ->> 'category' AND c.kind = v_kind) THEN
    problems := problems || jsonb_build_object('field', 'category', 'code', 'unavailable');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trucker.equipment_type e WHERE e.code = p_content ->> 'equipmentType') THEN
    problems := problems || jsonb_build_object('field', 'equipmentType', 'code', 'unavailable');
  END IF;
  -- A country for which this kind of vehicle has document requirements.
  IF NOT EXISTS (SELECT 1 FROM trucker.fleet_document_type t
                 WHERE t.country_code = p_content ->> 'registrationCountry' AND t.subject_kind = v_kind) THEN
    problems := problems || jsonb_build_object('field', 'registrationCountry', 'code', 'unavailable');
  END IF;
  IF v_number !~ '^[A-Z0-9]{2,20}$' THEN
    problems := problems || jsonb_build_object('field', 'registrationNumber', 'code', 'invalid');
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  SELECT * INTO v FROM trucker.vehicle x
  WHERE x.organisation_id = entered.org AND x.registration_country = p_content ->> 'registrationCountry'
    AND x.registration_number = v_number AND x.status = 'active';
  IF FOUND THEN
    status := 'exists';
    detail := trucker.vehicle_values(v, entered.at);
    RETURN;
  END IF;
  -- A truck owner holds one truck and one trailer (P2-1). One registration at a time for such
  -- an account, so two at the same moment cannot both pass.
  IF (SELECT o.kind FROM trucker.organisation o WHERE o.id = entered.org) = 'individual' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('vehicle.owner:' || entered.org::text, 0));
    IF EXISTS (SELECT 1 FROM trucker.vehicle x
               WHERE x.organisation_id = entered.org AND x.status = 'active' AND x.kind = v_kind) THEN
      status := 'owner_limit';
      RETURN;
    END IF;
  END IF;
  IF (SELECT count(*) FROM trucker.vehicle x WHERE x.organisation_id = entered.org AND x.status = 'active')
     >= (SELECT g.fleet_vehicle_limit FROM trucker.security_setting g) THEN
    status := 'limit';
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.vehicle
      (organisation_id, kind, category_code, equipment_type, registration_country, registration_number,
       created_by, created_at, updated_at)
    VALUES (entered.org, v_kind, p_content ->> 'category', p_content ->> 'equipmentType',
            p_content ->> 'registrationCountry', v_number, entered.actor, entered.at, entered.at)
    RETURNING * INTO v;
  EXCEPTION WHEN unique_violation THEN
    -- The same carrier registering the same number at the same moment.
    SELECT * INTO v FROM trucker.vehicle x
    WHERE x.organisation_id = entered.org AND x.registration_country = p_content ->> 'registrationCountry'
      AND x.registration_number = v_number AND x.status = 'active';
    status := 'exists';
    detail := trucker.vehicle_values(v, entered.at);
    RETURN;
  END;
  INSERT INTO trucker.fleet_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (entered.actor, p_key, 'vehicle', hash, v.id, entered.at);
  PERFORM trucker.fleet_audit(entered.at, entered.actor, NULL, entered.org, 'vehicle.registered', 'vehicle', v.id,
                              NULL, jsonb_build_object('kind', v.kind, 'ownership', 'claimed'));
  status := 'registered';
  detail := trucker.vehicle_values(v, entered.at);
END
$$;

-- Inviting a driver (replaces 0012's): refused for a truck-owner account (owner_only).
CREATE OR REPLACE FUNCTION trucker.invite_driver(p_key text, p_content jsonb, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  a trucker.driver_affiliation;
  v_phone text := btrim(coalesce(p_content ->> 'phone', ''));
  hash text := trucker.content_hash(coalesce(p_content, 'null'::jsonb));
BEGIN
  SELECT * INTO entered FROM trucker.fleet_carrier_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  -- The owner is the only driver of a truck-owner account (P2-1).
  IF (SELECT o.kind FROM trucker.organisation o WHERE o.id = entered.org) = 'individual' THEN
    status := 'owner_only';
    RETURN;
  END IF;
  SELECT * INTO seen FROM trucker.fleet_retry_seen(entered.actor, p_key, 'invite', hash, entered.at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' THEN 'repeated' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF v_phone !~ '^\+[1-9][0-9]{6,14}$' THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'phone', 'code', 'invalid'));
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.driver_affiliation x
             WHERE x.organisation_id = entered.org AND x.invited_phone = v_phone
               AND x.status IN ('invited', 'active')) THEN
    status := 'exists';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM trucker.driver_affiliation x
      WHERE x.organisation_id = entered.org AND x.status IN ('invited', 'active'))
     >= (SELECT g.fleet_driver_limit FROM trucker.security_setting g) THEN
    status := 'limit';
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.driver_affiliation (organisation_id, invited_phone, invited_by, invited_at)
    VALUES (entered.org, v_phone, entered.actor, entered.at) RETURNING * INTO a;
  EXCEPTION WHEN unique_violation THEN
    status := 'exists';
    RETURN;
  END;
  INSERT INTO trucker.fleet_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (entered.actor, p_key, 'invite', hash, a.id, entered.at);
  PERFORM trucker.fleet_audit(entered.at, entered.actor, NULL, entered.org, 'driver.invited', 'driver_affiliation',
                              a.id, NULL, jsonb_build_object('status', 'invited'));
  status := 'invited';
END
$$;

-- The owner becomes the driver of their own account, by their own recorded act and without
-- an invitation. The rule of one active affiliation per driver holds: someone driving for a
-- company cannot, and the unique index decides two attempts at the same moment.
--   status: affiliated | exists | affiliated_elsewhere | not_individual | unauthorized
--           | not_found | not_carrier
CREATE FUNCTION trucker.become_own_driver(OUT status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  a trucker.driver_affiliation;
BEGIN
  SELECT * INTO entered FROM trucker.fleet_carrier_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF (SELECT o.kind FROM trucker.organisation o WHERE o.id = entered.org) <> 'individual' THEN
    status := 'not_individual';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.driver_affiliation x
             WHERE x.person_id = entered.actor AND x.status = 'active') THEN
    status := CASE WHEN EXISTS (SELECT 1 FROM trucker.driver_affiliation x
                                WHERE x.person_id = entered.actor AND x.status = 'active'
                                  AND x.organisation_id = entered.org)
                   THEN 'exists' ELSE 'affiliated_elsewhere' END;
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.driver_affiliation
      (organisation_id, invited_phone, person_id, status, invited_by, invited_at, responded_at)
    SELECT entered.org, p.phone_e164, entered.actor, 'active', entered.actor, entered.at, entered.at
    FROM trucker.person p WHERE p.id = entered.actor
    RETURNING * INTO a;
  EXCEPTION WHEN unique_violation THEN
    status := 'affiliated_elsewhere';
    RETURN;
  END;
  PERFORM trucker.fleet_audit(entered.at, entered.actor, NULL, entered.org, 'driver.affiliation_accepted',
                              'driver_affiliation', a.id, NULL,
                              jsonb_build_object('status', 'active', 'self', true));
  status := 'affiliated';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may run what.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
REVOKE ALL ON FUNCTION trucker.capability_allowed(text, text), trucker.is_carrier(uuid),
  trucker.guard_personal_membership(), trucker.guard_organisation_kind(), trucker.guard_capability_kind()
  FROM trucker_app;
GRANT EXECUTE ON FUNCTION
  trucker.create_personal_account(text, text, text, text, boolean),
  trucker.staff_verification_queue(text),
  trucker.become_own_driver()
TO trucker_app;
