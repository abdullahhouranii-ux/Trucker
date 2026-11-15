-- 0012: fleet and drivers (slice 13).
--
-- A verified carrier company records its trucks, trailers and drivers. Four things are kept
-- separate and none implies another:
--   ownership claim     a carrier says a vehicle is its own; staff verify or reject the claim.
--                       A first claim is not proof of ownership. A conflicting claim is recorded,
--                       shown to staff only, reveals nothing to either carrier and restricts
--                       nobody by itself.
--   operating control   who may put the vehicle forward: in this release the verified owner.
--   document approval   each document is accepted or rejected by staff, with its own expiry.
--   availability        not decided here at all. Nothing is reserved, assigned or booked.
-- Eligibility is judged live by two functions over a time window, with the database clock and
-- without a worker; the booking slices call them inside their own locks.
--
-- Company carriers only; one active carrier affiliation per driver; a driver joins by accepting
-- an invitation in their own account. Document types, vehicle categories and licence classes
-- are registers that are empty after the migrations: fictional entries exist only in databases
-- marked local-development or test, and outside those every fleet command answers "closed".
-- A carrier's access to a driver's documents ends with the affiliation; how long the records
-- themselves are kept is an unresolved production requirement (SECURITY_BACKLOG.md).

-- ---------------------------------------------------------------------------------------------
-- Registers
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.vehicle_category (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  kind text NOT NULL CHECK (kind IN ('truck', 'trailer')),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 120),
  name_ar text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 120),
  name_ur text NOT NULL CHECK (length(btrim(name_ur)) BETWEEN 1 AND 120),
  position integer NOT NULL DEFAULT 1
);
CREATE TABLE trucker.licence_class (
  country_code text NOT NULL REFERENCES trucker.country (code),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 120),
  name_ar text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 120),
  name_ur text NOT NULL CHECK (length(btrim(name_ur)) BETWEEN 1 AND 120),
  position integer NOT NULL DEFAULT 1,
  PRIMARY KEY (country_code, code)
);
-- Which vehicle categories a licence class covers, per country.
CREATE TABLE trucker.licence_class_category (
  country_code text NOT NULL,
  class_code text NOT NULL,
  category_code text NOT NULL REFERENCES trucker.vehicle_category (code),
  PRIMARY KEY (country_code, class_code, category_code),
  FOREIGN KEY (country_code, class_code) REFERENCES trucker.licence_class (country_code, code)
);
CREATE TABLE trucker.fleet_document_type (
  country_code text NOT NULL REFERENCES trucker.country (code),
  subject_kind text NOT NULL CHECK (subject_kind IN ('truck', 'trailer', 'driver')),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 120),
  name_ar text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 120),
  name_ur text NOT NULL CHECK (length(btrim(name_ur)) BETWEEN 1 AND 120),
  required boolean NOT NULL DEFAULT true,
  -- A driving licence: the document states the licence classes held.
  carries_licence boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 1,
  PRIMARY KEY (country_code, subject_kind, code),
  CONSTRAINT fleet_document_type_licence CHECK (NOT carries_licence OR subject_kind = 'driver')
);
COMMENT ON TABLE trucker.fleet_document_type IS
  'Fictional until the real requirements are approved. Not a statement of what any law requires.';
COMMENT ON TABLE trucker.licence_class_category IS
  'Fictional until the real mapping is approved. Not a statement of what any licence permits.';
CREATE TRIGGER vehicle_category_guard BEFORE INSERT OR UPDATE ON trucker.vehicle_category
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_catalogue();
CREATE TRIGGER licence_class_guard BEFORE INSERT OR UPDATE ON trucker.licence_class
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_catalogue();
CREATE TRIGGER licence_class_category_guard BEFORE INSERT OR UPDATE ON trucker.licence_class_category
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_catalogue();
CREATE TRIGGER fleet_document_type_guard BEFORE INSERT OR UPDATE ON trucker.fleet_document_type
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_catalogue();
CREATE FUNCTION trucker.guard_environment_fleet_registers() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF NEW.kind NOT IN ('local-development', 'test')
     AND (EXISTS (SELECT 1 FROM trucker.vehicle_category) OR EXISTS (SELECT 1 FROM trucker.licence_class)
          OR EXISTS (SELECT 1 FROM trucker.fleet_document_type)) THEN
    RAISE EXCEPTION 'this database holds fictional fleet registers and cannot be marked %', NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER environment_guard_fleet_registers BEFORE UPDATE ON trucker.environment
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_environment_fleet_registers();

-- ---------------------------------------------------------------------------------------------
-- Vehicles: trucks and trailers, each with an ownership claim
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.vehicle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  kind text NOT NULL CHECK (kind IN ('truck', 'trailer')),
  category_code text NOT NULL REFERENCES trucker.vehicle_category (code),
  equipment_type text NOT NULL REFERENCES trucker.equipment_type (code),
  registration_country text NOT NULL REFERENCES trucker.country (code),
  -- Upper case, letters and digits only.
  registration_number text NOT NULL CHECK (registration_number ~ '^[A-Z0-9]{2,20}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  -- The claim that this organisation owns the vehicle. Decided by staff, never by registering.
  ownership text NOT NULL DEFAULT 'claimed' CHECK (ownership IN ('claimed', 'verified', 'rejected')),
  ownership_decided_by uuid REFERENCES trucker.staff_account (id),
  ownership_decided_at timestamptz,
  ownership_reason text,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid NOT NULL REFERENCES trucker.person (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  retired_at timestamptz,
  CONSTRAINT vehicle_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT vehicle_decided CHECK ((ownership = 'claimed') = (ownership_decided_at IS NULL))
);
-- A carrier holds one active record per registration.
CREATE UNIQUE INDEX vehicle_one_per_carrier
  ON trucker.vehicle (organisation_id, registration_country, registration_number) WHERE status = 'active';
-- Several carriers may claim the same registration; only one claim can be verified.
CREATE UNIQUE INDEX vehicle_one_verified_owner
  ON trucker.vehicle (registration_country, registration_number)
  WHERE status = 'active' AND ownership = 'verified';
CREATE INDEX vehicle_registration_idx ON trucker.vehicle (registration_country, registration_number);

-- ---------------------------------------------------------------------------------------------
-- Drivers: an affiliation between a person and one carrier, created by the driver's acceptance
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.driver_affiliation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  invited_phone text NOT NULL CHECK (invited_phone ~ '^\+[1-9][0-9]{6,14}$'),
  -- Known only from the person's own answer.
  person_id uuid REFERENCES trucker.person (id),
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'declined', 'cancelled', 'ended')),
  invited_by uuid NOT NULL REFERENCES trucker.person (id),
  invited_at timestamptz NOT NULL,
  responded_at timestamptz,
  ended_at timestamptz,
  ended_by text CHECK (ended_by IS NULL OR ended_by IN ('carrier', 'driver')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT driver_affiliation_person CHECK (status NOT IN ('active', 'declined', 'ended') OR person_id IS NOT NULL),
  CONSTRAINT driver_affiliation_ended CHECK ((status IN ('cancelled', 'ended')) = (ended_at IS NOT NULL))
);
-- One active carrier affiliation per driver.
CREATE UNIQUE INDEX driver_affiliation_one_active ON trucker.driver_affiliation (person_id) WHERE status = 'active';
CREATE UNIQUE INDEX driver_affiliation_one_open
  ON trucker.driver_affiliation (organisation_id, invited_phone) WHERE status IN ('invited', 'active');
CREATE INDEX driver_affiliation_phone_idx ON trucker.driver_affiliation (invited_phone) WHERE status = 'invited';

-- May this driver drive this vehicle, or every vehicle of the carrier (vehicle_id NULL)?
CREATE TABLE trucker.driver_authorisation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  affiliation_id uuid NOT NULL REFERENCES trucker.driver_affiliation (id),
  vehicle_id uuid REFERENCES trucker.vehicle (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by uuid NOT NULL REFERENCES trucker.person (id),
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT driver_authorisation_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX driver_authorisation_one_active ON trucker.driver_authorisation
  (affiliation_id, coalesce(vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'active';

-- ---------------------------------------------------------------------------------------------
-- Documents of vehicles and drivers. Numbers and dates only; files wait for a storage decision.
-- A driver's documents belong to the driver, whichever carrier they work with.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.fleet_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL CHECK (subject_kind IN ('vehicle', 'driver')),
  vehicle_id uuid REFERENCES trucker.vehicle (id),
  person_id uuid REFERENCES trucker.person (id),
  -- The carrier on whose behalf it was submitted: the vehicle's, or the driver's at that time.
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  country_code text NOT NULL,
  type_kind text NOT NULL,
  type_code text NOT NULL,
  document_number text NOT NULL CHECK (length(btrim(document_number)) BETWEEN 1 AND 60),
  issuing_country text NOT NULL REFERENCES trucker.country (code),
  issue_date date,
  expiry_date date NOT NULL,
  licence_classes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'accepted', 'rejected', 'superseded', 'withdrawn')),
  submitted_by uuid NOT NULL REFERENCES trucker.person (id),
  submitted_at timestamptz NOT NULL,
  decided_by uuid REFERENCES trucker.staff_account (id),
  decided_at timestamptz,
  decision_reason text,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (country_code, type_kind, type_code)
    REFERENCES trucker.fleet_document_type (country_code, subject_kind, code),
  CONSTRAINT fleet_document_subject CHECK (
    (subject_kind = 'vehicle' AND vehicle_id IS NOT NULL AND person_id IS NULL AND type_kind IN ('truck', 'trailer'))
    OR (subject_kind = 'driver' AND person_id IS NOT NULL AND vehicle_id IS NULL AND type_kind = 'driver')),
  CONSTRAINT fleet_document_dates CHECK (issue_date IS NULL OR issue_date <= expiry_date)
);
-- One awaiting a decision and one accepted, per subject, country and type.
CREATE UNIQUE INDEX fleet_document_one_submitted ON trucker.fleet_document
  (coalesce(vehicle_id, person_id), country_code, type_code) WHERE status = 'submitted';
CREATE UNIQUE INDEX fleet_document_one_accepted ON trucker.fleet_document
  (coalesce(vehicle_id, person_id), country_code, type_code) WHERE status = 'accepted';
CREATE INDEX fleet_document_queue_idx ON trucker.fleet_document (submitted_at) WHERE status = 'submitted';

-- A suspension of a vehicle or a driver by staff, with a reason. Open while ended_at is null.
CREATE TABLE trucker.fleet_suspension (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL CHECK (subject_kind IN ('vehicle', 'driver')),
  vehicle_id uuid REFERENCES trucker.vehicle (id),
  person_id uuid REFERENCES trucker.person (id),
  reason text NOT NULL CHECK (reason IN ('safety_review', 'document_concern', 'suspected_fraud', 'other')),
  started_at timestamptz NOT NULL,
  started_by uuid NOT NULL REFERENCES trucker.staff_account (id),
  ended_at timestamptz,
  ended_by uuid REFERENCES trucker.staff_account (id),
  CONSTRAINT fleet_suspension_subject CHECK (
    (subject_kind = 'vehicle' AND vehicle_id IS NOT NULL AND person_id IS NULL)
    OR (subject_kind = 'driver' AND person_id IS NOT NULL AND vehicle_id IS NULL))
);
CREATE UNIQUE INDEX fleet_suspension_one_open ON trucker.fleet_suspension
  (coalesce(vehicle_id, person_id)) WHERE ended_at IS NULL;

CREATE TABLE trucker.fleet_retry_key (
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9._-]{16,128}$'),
  operation text NOT NULL CHECK (operation IN (
    'vehicle', 'retire', 'vehicle_document', 'invite', 'end', 'authorise', 'respond', 'leave', 'driver_document')),
  request_hash text NOT NULL,
  record_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (person_id, key)
);

ALTER TABLE trucker.vehicle_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.licence_class ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.licence_class_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.fleet_document_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.vehicle ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.driver_affiliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.driver_authorisation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.fleet_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.fleet_suspension ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.fleet_retry_key ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.vehicle_category, trucker.licence_class, trucker.licence_class_category,
  trucker.fleet_document_type, trucker.vehicle, trucker.driver_affiliation, trucker.driver_authorisation,
  trucker.fleet_document, trucker.fleet_suspension, trucker.fleet_retry_key FROM trucker_app, PUBLIC;

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
    'quotation.reconfirmation_required',
    'vehicle.registered', 'vehicle.retired', 'vehicle.ownership_decided',
    'fleet_document.submitted', 'fleet_document.decided',
    'driver.invited', 'driver.invitation_cancelled', 'driver.invitation_declined',
    'driver.affiliation_accepted', 'driver.affiliation_ended',
    'driver.authorised', 'driver.authorisation_revoked',
    'fleet.suspended', 'fleet.suspension_ended')),
  DROP CONSTRAINT audit_entry_record_type_check,
  ADD CONSTRAINT audit_entry_record_type_check CHECK (record_type IN (
    'organisation', 'shipment_draft', 'verification_application', 'quotation',
    'vehicle', 'driver_affiliation', 'driver_authorisation', 'fleet_document'));

-- Protected settings, development defaults needing production review (FB-5).
ALTER TABLE trucker.security_setting
  ADD COLUMN fleet_vehicle_limit integer NOT NULL DEFAULT 200 CHECK (fleet_vehicle_limit BETWEEN 1 AND 100000),
  ADD COLUMN fleet_driver_limit integer NOT NULL DEFAULT 200 CHECK (fleet_driver_limit BETWEEN 1 AND 100000),
  ADD COLUMN fleet_document_version_limit integer NOT NULL DEFAULT 5
    CHECK (fleet_document_version_limit BETWEEN 1 AND 1000);

-- ---------------------------------------------------------------------------------------------
-- Building blocks (not callable by the API)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.fleet_registers_available(p_allow_fixtures boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(p_allow_fixtures, false)
     AND (SELECT e.kind FROM trucker.environment e) IN ('local-development', 'test')
$$;

-- Until when a document counts: the start of its expiry date in UTC. Its last day is not
-- counted, whatever the time zone, so that no document is treated as valid after it lapsed.
CREATE FUNCTION trucker.fleet_document_valid_until(p_expiry date) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_expiry::timestamp AT TIME ZONE 'UTC'
$$;

-- The first required document that does not cover the window, or NULL when all do.
--   document_missing | document_expired | document_expires_in_window
CREATE FUNCTION trucker.fleet_documents_cover(
  p_subject uuid, p_country text, p_kind text, p_from timestamptz, p_until timestamptz
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  t record;
  v_valid timestamptz;
BEGIN
  FOR t IN SELECT x.code FROM trucker.fleet_document_type x
           WHERE x.country_code = p_country AND x.subject_kind = p_kind AND x.required
           ORDER BY x.position, x.code LOOP
    SELECT trucker.fleet_document_valid_until(d.expiry_date) INTO v_valid
    FROM trucker.fleet_document d
    WHERE coalesce(d.vehicle_id, d.person_id) = p_subject AND d.country_code = p_country
      AND d.type_kind = p_kind AND d.type_code = t.code AND d.status = 'accepted';
    IF NOT FOUND THEN
      RETURN 'document_missing';
    ELSIF v_valid <= p_from THEN
      RETURN 'document_expired';
    ELSIF v_valid < p_until THEN
      RETURN 'document_expires_in_window';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

-- Who holds operating control of a vehicle: in this release the organisation whose ownership
-- claim is verified. NULL while no claim is verified.
CREATE FUNCTION trucker.vehicle_operating_controller(p_vehicle uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT v.organisation_id FROM trucker.vehicle v
  WHERE v.id = p_vehicle AND v.status = 'active' AND v.ownership = 'verified'
$$;

-- May this organisation put this vehicle forward for the window [p_from, p_until)?
-- "eligible", or the first reason it may not. Says nothing about availability. The caller holds
-- whatever locks its own decision needs.
--   not_found | carrier_not_eligible | ownership_not_verified | not_operating_controller
--   | suspended | document_missing | document_expired | document_expires_in_window
--   | equipment_mismatch
CREATE FUNCTION trucker.vehicle_eligibility(
  p_vehicle uuid, p_organisation uuid, p_from timestamptz, p_until timestamptz, p_equipment text
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  IF NOT trucker.capability_effective(v.organisation_id, 'carry_as_company') THEN
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

-- May this driver be put forward by their carrier for the window, optionally for one vehicle?
--   not_affiliated | carrier_not_eligible | suspended | document_missing | document_expired
--   | document_expires_in_window | vehicle_not_found | not_authorised | licence_class_not_covering
CREATE FUNCTION trucker.driver_eligibility(
  p_affiliation uuid, p_vehicle uuid, p_from timestamptz, p_until timestamptz
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  IF NOT trucker.capability_effective(a.organisation_id, 'carry_as_company') THEN
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
           AND trucker.fleet_document_valid_until(d.expiry_date) >= p_until) THEN
      RETURN 'licence_class_not_covering';
    END IF;
  END IF;
  RETURN 'eligible';
END
$$;

CREATE FUNCTION trucker.fleet_retry_seen(
  p_person uuid, p_key text, p_operation text, p_hash text, p_at timestamptz, OUT seen text, OUT record_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  earlier trucker.fleet_retry_key;
  g trucker.security_setting;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO g FROM trucker.security_setting;
  SELECT * INTO earlier FROM trucker.fleet_retry_key k WHERE k.person_id = p_person AND k.key = p_key;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF earlier.created_at <= p_at - make_interval(hours => g.retry_key_retention_hours) THEN
    DELETE FROM trucker.fleet_retry_key k WHERE k.person_id = p_person AND k.key = p_key;
    RETURN;
  END IF;
  record_id := earlier.record_id;
  seen := CASE WHEN earlier.operation = p_operation AND earlier.request_hash = p_hash
               THEN 'repeated' ELSE 'key_conflict' END;
END
$$;

CREATE FUNCTION trucker.fleet_audit(
  p_at timestamptz, p_person uuid, p_staff uuid, p_organisation uuid, p_action text, p_type text,
  p_record uuid, p_before jsonb, p_after jsonb
) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES (p_at, p_person, p_staff, p_organisation, p_action, p_type, p_record,
          nullif(current_setting('trucker.request_id', true), ''), p_before, p_after)
$$;

-- The opening of every carrier command: an administrator of the organisation named by the
-- request, the organisation locked, then the clock. Someone who is not an administrator is
-- answered as for a record that does not exist.
--   status: ok | unauthorized | not_found | not_carrier
CREATE FUNCTION trucker.fleet_carrier_enter(OUT status text, OUT actor uuid, OUT org uuid, OUT at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  status := CASE WHEN trucker.capability_effective(org, 'carry_as_company') THEN 'ok' ELSE 'not_carrier' END;
END
$$;

-- One document as shown. p_full false leaves out its number: a carrier sees of a driver's
-- document only what it is, whether it stands and when it lapses.
CREATE FUNCTION trucker.fleet_document_values(d trucker.fleet_document, p_full boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'id', d.id, 'type', d.type_code, 'country', d.country_code, 'status', d.status,
    'expiryDate', to_char(d.expiry_date, 'YYYY-MM-DD'),
    'licenceClasses', to_jsonb(d.licence_classes),
    'submittedAt', d.submitted_at, 'decidedAt', d.decided_at, 'reason', d.decision_reason,
    'version', d.row_version)
    || CASE WHEN p_full THEN jsonb_build_object(
         'documentNumber', d.document_number, 'issuingCountry', d.issuing_country,
         'issueDate', to_char(d.issue_date, 'YYYY-MM-DD')) ELSE '{}'::jsonb END)
$$;

CREATE FUNCTION trucker.fleet_documents_of(p_subject uuid, p_full boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(jsonb_agg(trucker.fleet_document_values(d, p_full) ORDER BY d.submitted_at DESC, d.id), '[]'::jsonb)
  FROM trucker.fleet_document d
  WHERE coalesce(d.vehicle_id, d.person_id) = p_subject AND d.status IN ('submitted', 'accepted', 'rejected')
$$;

CREATE FUNCTION trucker.vehicle_values(v trucker.vehicle, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', v.id, 'kind', v.kind, 'category', v.category_code, 'equipmentType', v.equipment_type,
    'registrationCountry', v.registration_country, 'registrationNumber', v.registration_number,
    'status', v.status, 'ownership', v.ownership, 'version', v.row_version,
    'eligibility', CASE WHEN v.status = 'active'
                        THEN trucker.vehicle_eligibility(v.id, v.organisation_id, p_at, p_at, NULL)
                        ELSE 'not_found' END,
    'documents', trucker.fleet_documents_of(v.id, true))
$$;

-- A driver as the carrier sees them. Documents only while the affiliation is active.
CREATE FUNCTION trucker.driver_affiliation_values(a trucker.driver_affiliation, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'id', a.id, 'status', a.status, 'phone', a.invited_phone, 'version', a.row_version,
    'invitedAt', a.invited_at, 'respondedAt', a.responded_at, 'endedAt', a.ended_at, 'endedBy', a.ended_by,
    'name', CASE WHEN a.status IN ('active', 'ended')
                 THEN (SELECT p.display_name FROM trucker.person p WHERE p.id = a.person_id) END)
    || CASE WHEN a.status = 'active' THEN jsonb_build_object(
         'eligibility', trucker.driver_eligibility(a.id, NULL, p_at, p_at),
         'documents', trucker.fleet_documents_of(a.person_id, false),
         'authorisations', coalesce((
           SELECT jsonb_agg(jsonb_build_object('id', z.id, 'vehicleId', z.vehicle_id) ORDER BY z.granted_at, z.id)
           FROM trucker.driver_authorisation z WHERE z.affiliation_id = a.id AND z.status = 'active'), '[]'::jsonb))
       ELSE '{}'::jsonb END)
$$;

CREATE FUNCTION trucker.fleet_registers(p_country text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'categories', coalesce((
      SELECT jsonb_agg(jsonb_build_object('code', c.code, 'kind', c.kind,
               'name', jsonb_build_object('en', c.name_en, 'ar', c.name_ar, 'ur', c.name_ur))
               ORDER BY c.position, c.code) FROM trucker.vehicle_category c), '[]'::jsonb),
    'documentTypes', coalesce((
      SELECT jsonb_agg(jsonb_build_object('country', t.country_code, 'subject', t.subject_kind, 'code', t.code,
               'required', t.required, 'carriesLicence', t.carries_licence,
               'name', jsonb_build_object('en', t.name_en, 'ar', t.name_ar, 'ur', t.name_ur))
               ORDER BY t.country_code, t.subject_kind, t.position, t.code)
      FROM trucker.fleet_document_type t WHERE p_country IS NULL OR t.country_code = p_country), '[]'::jsonb),
    'licenceClasses', coalesce((
      SELECT jsonb_agg(jsonb_build_object('country', l.country_code, 'code', l.code,
               'name', jsonb_build_object('en', l.name_en, 'ar', l.name_ar, 'ur', l.name_ur))
               ORDER BY l.country_code, l.position, l.code)
      FROM trucker.licence_class l WHERE p_country IS NULL OR l.country_code = p_country), '[]'::jsonb))
$$;

-- Checks a document as typed and returns the problems by field.
CREATE FUNCTION trucker.fleet_document_problems(
  p_content jsonb, p_country text, p_kind text, p_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  problems jsonb := '[]'::jsonb;
  t trucker.fleet_document_type;
  v_number text := btrim(coalesce(p_content ->> 'documentNumber', ''));
  v_expiry date;
  v_issue date;
  v_classes jsonb := coalesce(p_content -> 'licenceClasses', '[]'::jsonb);
BEGIN
  SELECT * INTO t FROM trucker.fleet_document_type x
  WHERE x.country_code = p_country AND x.subject_kind = p_kind AND x.code = p_content ->> 'type';
  IF NOT FOUND THEN
    RETURN jsonb_build_array(jsonb_build_object('field', 'type', 'code', 'unavailable'));
  END IF;
  IF length(v_number) NOT BETWEEN 1 AND 60 THEN
    problems := problems || jsonb_build_object('field', 'documentNumber', 'code', 'required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trucker.country c WHERE c.code = p_content ->> 'issuingCountry') THEN
    problems := problems || jsonb_build_object('field', 'issuingCountry', 'code', 'unavailable');
  END IF;
  IF coalesce(p_content ->> 'expiryDate', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    problems := problems || jsonb_build_object('field', 'expiryDate', 'code', 'required');
  ELSE
    BEGIN
      v_expiry := (p_content ->> 'expiryDate')::date;
      IF trucker.fleet_document_valid_until(v_expiry) <= p_at THEN
        problems := problems || jsonb_build_object('field', 'expiryDate', 'code', 'past');
      END IF;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      problems := problems || jsonb_build_object('field', 'expiryDate', 'code', 'invalid');
    END;
  END IF;
  IF p_content ? 'issueDate' AND p_content ->> 'issueDate' IS NOT NULL THEN
    IF p_content ->> 'issueDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      problems := problems || jsonb_build_object('field', 'issueDate', 'code', 'invalid');
    ELSE
      BEGIN
        v_issue := (p_content ->> 'issueDate')::date;
        IF v_issue::timestamp AT TIME ZONE 'UTC' > p_at OR (v_expiry IS NOT NULL AND v_issue > v_expiry) THEN
          problems := problems || jsonb_build_object('field', 'issueDate', 'code', 'invalid');
        END IF;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        problems := problems || jsonb_build_object('field', 'issueDate', 'code', 'invalid');
      END;
    END IF;
  END IF;
  IF jsonb_typeof(v_classes) <> 'array' THEN
    problems := problems || jsonb_build_object('field', 'licenceClasses', 'code', 'invalid');
  ELSIF t.carries_licence THEN
    IF jsonb_array_length(v_classes) = 0 THEN
      problems := problems || jsonb_build_object('field', 'licenceClasses', 'code', 'required');
    ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(v_classes) e
                  WHERE jsonb_typeof(e) <> 'string' OR NOT EXISTS (
                    SELECT 1 FROM trucker.licence_class l
                    WHERE l.country_code = p_country AND l.code = e #>> '{}')) THEN
      problems := problems || jsonb_build_object('field', 'licenceClasses', 'code', 'unavailable');
    END IF;
  ELSIF jsonb_array_length(v_classes) > 0 THEN
    problems := problems || jsonb_build_object('field', 'licenceClasses', 'code', 'invalid');
  END IF;
  RETURN problems;
END
$$;

-- Stores a checked document: one already awaiting a decision is replaced by it.
--   NULL when the version limit is reached.
CREATE FUNCTION trucker.fleet_document_store(
  p_kind text, p_vehicle uuid, p_person uuid, p_organisation uuid, p_country text, p_type_kind text,
  p_content jsonb, p_actor uuid, p_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_subject uuid := coalesce(p_vehicle, p_person);
  v_id uuid;
BEGIN
  IF (SELECT count(*) FROM trucker.fleet_document d
      WHERE coalesce(d.vehicle_id, d.person_id) = v_subject AND d.country_code = p_country
        AND d.type_code = p_content ->> 'type')
     >= (SELECT g.fleet_document_version_limit FROM trucker.security_setting g) THEN
    RETURN NULL;
  END IF;
  UPDATE trucker.fleet_document d SET status = 'withdrawn', row_version = d.row_version + 1
  WHERE coalesce(d.vehicle_id, d.person_id) = v_subject AND d.country_code = p_country
    AND d.type_code = p_content ->> 'type' AND d.status = 'submitted';
  INSERT INTO trucker.fleet_document
    (subject_kind, vehicle_id, person_id, organisation_id, country_code, type_kind, type_code,
     document_number, issuing_country, issue_date, expiry_date, licence_classes, submitted_by, submitted_at)
  VALUES (p_kind, p_vehicle, p_person, p_organisation, p_country, p_type_kind, p_content ->> 'type',
          btrim(p_content ->> 'documentNumber'), p_content ->> 'issuingCountry',
          nullif(p_content ->> 'issueDate', '')::date, (p_content ->> 'expiryDate')::date,
          coalesce((SELECT array_agg(e #>> '{}' ORDER BY e #>> '{}')
                    FROM jsonb_array_elements(coalesce(p_content -> 'licenceClasses', '[]'::jsonb)) e), '{}'),
          p_actor, p_at)
  RETURNING id INTO v_id;
  PERFORM trucker.fleet_audit(p_at, p_actor, NULL, p_organisation, 'fleet_document.submitted', 'fleet_document',
                              v_id, NULL, jsonb_build_object('type', p_content ->> 'type', 'subject', p_kind));
  RETURN v_id;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The carrier
-- ---------------------------------------------------------------------------------------------
-- Everything the carrier's administrators see: vehicles, drivers and the registers.
--   status: ok | unauthorized | not_found | not_carrier
CREATE FUNCTION trucker.fleet_overview(p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
BEGIN
  SELECT * INTO entered FROM trucker.fleet_carrier_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  detail := jsonb_build_object(
    'open', trucker.fleet_registers_available(p_allow_fixtures),
    'vehicles', coalesce((
      SELECT jsonb_agg(trucker.vehicle_values(v, entered.at) ORDER BY v.created_at, v.id)
      FROM trucker.vehicle v WHERE v.organisation_id = entered.org), '[]'::jsonb),
    'drivers', coalesce((
      SELECT jsonb_agg(trucker.driver_affiliation_values(a, entered.at) ORDER BY a.invited_at, a.id)
      FROM trucker.driver_affiliation a WHERE a.organisation_id = entered.org), '[]'::jsonb),
    'registers', CASE WHEN trucker.fleet_registers_available(p_allow_fixtures)
                      THEN trucker.fleet_registers(NULL) ELSE '{}'::jsonb END);
END
$$;

-- Registers a truck or trailer with an ownership claim. A claim by another carrier on the same
-- registration changes nothing here and is not disclosed.
--   p_content: {"kind","category","equipmentType","registrationCountry","registrationNumber"}
--   status: registered | repeated | exists | invalid | limit | closed | key_conflict
--           | unauthorized | not_found | not_carrier
CREATE FUNCTION trucker.register_vehicle(
  p_key text, p_content jsonb, p_allow_fixtures boolean, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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

-- Retires a vehicle. Its authorisations end with it.
--   status: retired | already_retired | conflict | unauthorized | not_found | not_carrier | key_conflict
CREATE FUNCTION trucker.retire_vehicle(p_vehicle uuid, p_expected_version integer, p_key text, OUT status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  v trucker.vehicle;
  hash text := trucker.content_hash(jsonb_build_object('v', p_expected_version));
BEGIN
  SELECT * INTO entered FROM trucker.fleet_carrier_enter();
  status := entered.status;
  IF status NOT IN ('ok', 'not_carrier') THEN
    RETURN;
  END IF;
  SELECT * INTO v FROM trucker.vehicle x WHERE x.id = p_vehicle AND x.organisation_id = entered.org FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO seen FROM trucker.fleet_retry_seen(entered.actor, p_key, 'retire', hash, entered.at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' AND seen.record_id = v.id THEN 'already_retired' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF v.status = 'retired' THEN
    status := 'already_retired';
    RETURN;
  END IF;
  IF v.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  UPDATE trucker.vehicle x SET status = 'retired', retired_at = entered.at, updated_at = entered.at,
                               row_version = x.row_version + 1 WHERE x.id = v.id;
  UPDATE trucker.driver_authorisation z SET status = 'revoked', revoked_at = entered.at
  WHERE z.vehicle_id = v.id AND z.status = 'active';
  INSERT INTO trucker.fleet_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (entered.actor, p_key, 'retire', hash, v.id, entered.at);
  PERFORM trucker.fleet_audit(entered.at, entered.actor, NULL, entered.org, 'vehicle.retired', 'vehicle', v.id,
                              jsonb_build_object('status', 'active'), jsonb_build_object('status', 'retired'));
  status := 'retired';
END
$$;

-- Submits a document of one of the carrier's vehicles.
--   p_content: {"type","documentNumber","issuingCountry","issueDate"?,"expiryDate"}
--   status: submitted | repeated | invalid | limit | closed | key_conflict | unauthorized
--           | not_found | not_carrier
CREATE FUNCTION trucker.submit_vehicle_document(
  p_vehicle uuid, p_key text, p_content jsonb, p_allow_fixtures boolean, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  v trucker.vehicle;
  v_id uuid;
  problems jsonb;
  hash text := trucker.content_hash(coalesce(p_content, 'null'::jsonb) || jsonb_build_object('_s', p_vehicle));
BEGIN
  SELECT * INTO entered FROM trucker.fleet_carrier_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO v FROM trucker.vehicle x
  WHERE x.id = p_vehicle AND x.organisation_id = entered.org AND x.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO seen FROM trucker.fleet_retry_seen(entered.actor, p_key, 'vehicle_document', hash, entered.at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' THEN 'repeated' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF NOT trucker.fleet_registers_available(p_allow_fixtures) THEN
    status := 'closed';
    RETURN;
  END IF;
  problems := trucker.fleet_document_problems(p_content, v.registration_country, v.kind, entered.at);
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  v_id := trucker.fleet_document_store('vehicle', v.id, NULL, entered.org, v.registration_country, v.kind,
                                       p_content, entered.actor, entered.at);
  IF v_id IS NULL THEN
    status := 'limit';
    RETURN;
  END IF;
  INSERT INTO trucker.fleet_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (entered.actor, p_key, 'vehicle_document', hash, v_id, entered.at);
  status := 'submitted';
END
$$;

-- Invites a driver by mobile number. Whether a person has that number, or already works with
-- another carrier, is not disclosed: the invitation is recorded either way.
--   p_content: {"phone": "+..."}
--   status: invited | repeated | exists | invalid | limit | key_conflict | unauthorized
--           | not_found | not_carrier
CREATE FUNCTION trucker.invite_driver(p_key text, p_content jsonb, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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

-- Ends an affiliation, by whichever side. With it end its authorisations and the carrier's
-- access to the driver's documents.
CREATE FUNCTION trucker.driver_affiliation_end(
  a trucker.driver_affiliation, p_by text, p_actor uuid, p_at timestamptz
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_status text := CASE WHEN a.status = 'invited' THEN 'cancelled' ELSE 'ended' END;
BEGIN
  UPDATE trucker.driver_affiliation x
  SET status = v_status, ended_at = p_at, ended_by = p_by, row_version = x.row_version + 1 WHERE x.id = a.id;
  UPDATE trucker.driver_authorisation z SET status = 'revoked', revoked_at = p_at
  WHERE z.affiliation_id = a.id AND z.status = 'active';
  PERFORM trucker.fleet_audit(
    p_at, p_actor, NULL, a.organisation_id,
    CASE WHEN a.status = 'invited' THEN 'driver.invitation_cancelled' ELSE 'driver.affiliation_ended' END,
    'driver_affiliation', a.id, jsonb_build_object('status', a.status),
    jsonb_build_object('status', v_status, 'by', p_by));
END
$$;

-- The carrier cancels an invitation or ends an affiliation.
--   status: ended | already_ended | conflict | key_conflict | unauthorized | not_found | not_carrier
CREATE FUNCTION trucker.end_driver_affiliation(
  p_affiliation uuid, p_expected_version integer, p_key text, OUT status text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  a trucker.driver_affiliation;
  hash text := trucker.content_hash(jsonb_build_object('v', p_expected_version));
BEGIN
  SELECT * INTO entered FROM trucker.fleet_carrier_enter();
  status := entered.status;
  IF status NOT IN ('ok', 'not_carrier') THEN
    RETURN;
  END IF;
  SELECT * INTO a FROM trucker.driver_affiliation x
  WHERE x.id = p_affiliation AND x.organisation_id = entered.org FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO seen FROM trucker.fleet_retry_seen(entered.actor, p_key, 'end', hash, entered.at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' AND seen.record_id = a.id THEN 'already_ended' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF a.status NOT IN ('invited', 'active') THEN
    status := 'already_ended';
    RETURN;
  END IF;
  IF a.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  PERFORM trucker.driver_affiliation_end(a, 'carrier', entered.actor, entered.at);
  INSERT INTO trucker.fleet_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (entered.actor, p_key, 'end', hash, a.id, entered.at);
  status := 'ended';
END
$$;

-- Authorises a driver for one vehicle or for all (vehicleId null), or takes that back.
--   p_content: {"vehicleId": uuid | null, "granted": boolean}
--   status: changed | unchanged | invalid | key_conflict | unauthorized | not_found | not_carrier
CREATE FUNCTION trucker.set_driver_authorisation(p_affiliation uuid, p_key text, p_content jsonb, OUT status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  a trucker.driver_affiliation;
  held trucker.driver_authorisation;
  v_vehicle uuid;
  v_granted boolean;
  hash text := trucker.content_hash(coalesce(p_content, 'null'::jsonb) || jsonb_build_object('_a', p_affiliation));
BEGIN
  SELECT * INTO entered FROM trucker.fleet_carrier_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO a FROM trucker.driver_affiliation x
  WHERE x.id = p_affiliation AND x.organisation_id = entered.org AND x.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO seen FROM trucker.fleet_retry_seen(entered.actor, p_key, 'authorise', hash, entered.at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' THEN 'unchanged' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF jsonb_typeof(p_content -> 'granted') IS DISTINCT FROM 'boolean'
     OR (p_content ->> 'vehicleId' IS NOT NULL
         AND p_content ->> 'vehicleId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    status := 'invalid';
    RETURN;
  END IF;
  v_granted := (p_content ->> 'granted')::boolean;
  v_vehicle := (p_content ->> 'vehicleId')::uuid;
  IF v_vehicle IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM trucker.vehicle x
       WHERE x.id = v_vehicle AND x.organisation_id = entered.org AND x.status = 'active') THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO held FROM trucker.driver_authorisation z
  WHERE z.affiliation_id = a.id AND z.status = 'active' AND z.vehicle_id IS NOT DISTINCT FROM v_vehicle;
  IF FOUND = v_granted THEN
    status := 'unchanged';
    RETURN;
  END IF;
  IF v_granted THEN
    INSERT INTO trucker.driver_authorisation (organisation_id, affiliation_id, vehicle_id, granted_by, granted_at)
    VALUES (entered.org, a.id, v_vehicle, entered.actor, entered.at) RETURNING * INTO held;
  ELSE
    UPDATE trucker.driver_authorisation z SET status = 'revoked', revoked_at = entered.at WHERE z.id = held.id;
  END IF;
  INSERT INTO trucker.fleet_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (entered.actor, p_key, 'authorise', hash, held.id, entered.at);
  PERFORM trucker.fleet_audit(
    entered.at, entered.actor, NULL, entered.org,
    CASE WHEN v_granted THEN 'driver.authorised' ELSE 'driver.authorisation_revoked' END,
    'driver_authorisation', held.id, NULL,
    jsonb_build_object('affiliation', a.id, 'vehicle', v_vehicle, 'granted', v_granted));
  status := 'changed';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The driver, in their own account
-- ---------------------------------------------------------------------------------------------
-- Invitations sent to the caller's own number, the active affiliation, own documents.
--   status: ok | unauthorized
CREATE FUNCTION trucker.driver_overview(p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_phone text;
  a trucker.driver_affiliation;
  v_country text;
  v_at timestamptz;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT p.phone_e164 INTO v_phone FROM trucker.person p WHERE p.id = actor;
  v_at := trucker.clock_now();
  SELECT * INTO a FROM trucker.driver_affiliation x WHERE x.person_id = actor AND x.status = 'active';
  IF FOUND THEN
    SELECT o.country_code INTO v_country FROM trucker.organisation o WHERE o.id = a.organisation_id;
  END IF;
  status := 'ok';
  detail := jsonb_build_object(
    'invitations', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', x.id, 'invitedAt', x.invited_at, 'version', x.row_version,
               'carrier', (SELECT jsonb_build_object('legalName', o.legal_name, 'tradingName', o.trading_name)
                           FROM trucker.organisation o WHERE o.id = x.organisation_id))
               ORDER BY x.invited_at, x.id)
      FROM trucker.driver_affiliation x WHERE x.invited_phone = v_phone AND x.status = 'invited'), '[]'::jsonb),
    'affiliation', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', a.id, 'since', a.responded_at, 'version', a.row_version, 'country', v_country,
      'eligibility', trucker.driver_eligibility(a.id, NULL, v_at, v_at),
      'carrier', (SELECT jsonb_build_object('legalName', o.legal_name, 'tradingName', o.trading_name)
                  FROM trucker.organisation o WHERE o.id = a.organisation_id)) END,
    'documents', trucker.fleet_documents_of(actor, true),
    'open', trucker.fleet_registers_available(p_allow_fixtures),
    'registers', CASE WHEN v_country IS NOT NULL AND trucker.fleet_registers_available(p_allow_fixtures)
                      THEN trucker.fleet_registers(v_country) ELSE '{}'::jsonb END);
END
$$;

-- The driver accepts or declines an invitation sent to their own number.
--   status: accepted | declined | already_answered | affiliation_exists | limit | invalid
--           | conflict | key_conflict | unauthorized | not_found
CREATE FUNCTION trucker.respond_driver_invitation(
  p_affiliation uuid, p_expected_version integer, p_key text, p_decision text, OUT status text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_phone text;
  a trucker.driver_affiliation;
  seen record;
  v_at timestamptz;
  hash text := trucker.content_hash(jsonb_build_object('d', p_decision, 'v', p_expected_version));
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('accept', 'decline') THEN
    status := 'invalid';
    RETURN;
  END IF;
  -- The person's own row is locked first, so that two acceptances by one person run in turn.
  SELECT p.phone_e164 INTO v_phone FROM trucker.person p WHERE p.id = actor FOR UPDATE;
  SELECT * INTO a FROM trucker.driver_affiliation x
  WHERE x.id = p_affiliation AND x.invited_phone = v_phone FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  SELECT * INTO seen FROM trucker.fleet_retry_seen(actor, p_key, 'respond', hash, v_at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' AND seen.record_id = a.id THEN 'already_answered' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF a.status <> 'invited' THEN
    status := CASE WHEN a.person_id = actor THEN 'already_answered' ELSE 'not_found' END;
    RETURN;
  END IF;
  IF a.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF p_decision = 'accept' THEN
    IF EXISTS (SELECT 1 FROM trucker.driver_affiliation x WHERE x.person_id = actor AND x.status = 'active') THEN
      status := 'affiliation_exists';
      RETURN;
    END IF;
    UPDATE trucker.driver_affiliation x
    SET status = 'active', person_id = actor, responded_at = v_at, row_version = x.row_version + 1
    WHERE x.id = a.id;
    PERFORM trucker.fleet_audit(v_at, actor, NULL, a.organisation_id, 'driver.affiliation_accepted',
                                'driver_affiliation', a.id, jsonb_build_object('status', 'invited'),
                                jsonb_build_object('status', 'active'));
    status := 'accepted';
  ELSE
    UPDATE trucker.driver_affiliation x
    SET status = 'declined', person_id = actor, responded_at = v_at, row_version = x.row_version + 1
    WHERE x.id = a.id;
    PERFORM trucker.fleet_audit(v_at, actor, NULL, a.organisation_id, 'driver.invitation_declined',
                                'driver_affiliation', a.id, jsonb_build_object('status', 'invited'),
                                jsonb_build_object('status', 'declined'));
    status := 'declined';
  END IF;
  INSERT INTO trucker.fleet_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (actor, p_key, 'respond', hash, a.id, v_at);
END
$$;

-- The driver leaves their carrier.
--   status: ended | already_ended | conflict | key_conflict | unauthorized | not_found
CREATE FUNCTION trucker.leave_driver_affiliation(
  p_affiliation uuid, p_expected_version integer, p_key text, OUT status text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  a trucker.driver_affiliation;
  seen record;
  v_at timestamptz;
  hash text := trucker.content_hash(jsonb_build_object('v', p_expected_version));
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO a FROM trucker.driver_affiliation x WHERE x.id = p_affiliation AND x.person_id = actor FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  SELECT * INTO seen FROM trucker.fleet_retry_seen(actor, p_key, 'leave', hash, v_at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' AND seen.record_id = a.id THEN 'already_ended' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF a.status <> 'active' THEN
    status := 'already_ended';
    RETURN;
  END IF;
  IF a.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  PERFORM trucker.driver_affiliation_end(a, 'driver', actor, v_at);
  INSERT INTO trucker.fleet_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (actor, p_key, 'leave', hash, a.id, v_at);
  status := 'ended';
END
$$;

-- The driver submits one of their own documents, for the country of their carrier.
--   status: submitted | repeated | invalid | limit | closed | not_affiliated | key_conflict | unauthorized
CREATE FUNCTION trucker.submit_driver_document(
  p_key text, p_content jsonb, p_allow_fixtures boolean, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  a trucker.driver_affiliation;
  seen record;
  v_country text;
  v_at timestamptz;
  v_id uuid;
  problems jsonb;
  hash text := trucker.content_hash(coalesce(p_content, 'null'::jsonb));
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO a FROM trucker.driver_affiliation x WHERE x.person_id = actor AND x.status = 'active' FOR UPDATE;
  v_at := trucker.clock_now();
  SELECT * INTO seen FROM trucker.fleet_retry_seen(actor, p_key, 'driver_document', hash, v_at);
  IF seen.seen IS NOT NULL THEN
    status := CASE WHEN seen.seen = 'repeated' THEN 'repeated' ELSE 'key_conflict' END;
    RETURN;
  END IF;
  IF a.id IS NULL THEN
    status := 'not_affiliated';
    RETURN;
  END IF;
  IF NOT trucker.fleet_registers_available(p_allow_fixtures) THEN
    status := 'closed';
    RETURN;
  END IF;
  SELECT o.country_code INTO v_country FROM trucker.organisation o WHERE o.id = a.organisation_id;
  problems := trucker.fleet_document_problems(p_content, v_country, 'driver', v_at);
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  v_id := trucker.fleet_document_store('driver', NULL, actor, a.organisation_id, v_country, 'driver',
                                       p_content, actor, v_at);
  IF v_id IS NULL THEN
    status := 'limit';
    RETURN;
  END IF;
  INSERT INTO trucker.fleet_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (actor, p_key, 'driver_document', hash, v_id, v_at);
  status := 'submitted';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------------------------
-- What waits for a decision: ownership claims and documents. A claim shows the other active
-- claims on the same registration; nobody but staff sees those.
--   status: ok | unauthorized | forbidden
CREATE FUNCTION trucker.staff_fleet_queue(p_token_hash text, p_request_id text, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, NULL, 'staff.fleet_view', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT (trucker.staff_privileges(entered.staff_id) && ARRAY['reviewer', 'staff_admin']) THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.fleet_view', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'privilege_not_held'));
    status := 'forbidden';
    RETURN;
  END IF;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.fleet_view', 'done', NULL, p_request_id, '{}'::jsonb);
  detail := jsonb_build_object(
    'claims', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', v.id, 'kind', v.kind, 'category', v.category_code, 'equipmentType', v.equipment_type,
               'registrationCountry', v.registration_country, 'registrationNumber', v.registration_number,
               'ownership', v.ownership, 'version', v.row_version, 'registeredAt', v.created_at,
               'carrier', jsonb_build_object('id', o.id, 'legalName', o.legal_name),
               'suspended', EXISTS (SELECT 1 FROM trucker.fleet_suspension s
                                    WHERE s.vehicle_id = v.id AND s.ended_at IS NULL),
               'otherClaims', coalesce((
                 SELECT jsonb_agg(jsonb_build_object('vehicleId', w.id, 'ownership', w.ownership,
                          'carrier', (SELECT p.legal_name FROM trucker.organisation p WHERE p.id = w.organisation_id))
                          ORDER BY w.created_at, w.id)
                 FROM trucker.vehicle w
                 WHERE w.registration_country = v.registration_country
                   AND w.registration_number = v.registration_number AND w.status = 'active' AND w.id <> v.id),
                 '[]'::jsonb)) ORDER BY v.created_at, v.id)
      FROM trucker.vehicle v JOIN trucker.organisation o ON o.id = v.organisation_id
      WHERE v.status = 'active' AND v.ownership = 'claimed'), '[]'::jsonb),
    'documents', coalesce((
      SELECT jsonb_agg(trucker.fleet_document_values(d, true) || jsonb_build_object(
               'subject', d.subject_kind, 'vehicleId', d.vehicle_id, 'personId', d.person_id,
               'registrationNumber', (SELECT v.registration_number FROM trucker.vehicle v WHERE v.id = d.vehicle_id),
               'driverName', (SELECT p.display_name FROM trucker.person p WHERE p.id = d.person_id),
               'carrier', (SELECT jsonb_build_object('id', o.id, 'legalName', o.legal_name)
                           FROM trucker.organisation o WHERE o.id = d.organisation_id))
               ORDER BY d.submitted_at, d.id)
      FROM trucker.fleet_document d WHERE d.status = 'submitted'), '[]'::jsonb),
    'suspensions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'subject', s.subject_kind, 'vehicleId', s.vehicle_id,
               'personId', s.person_id, 'reason', s.reason, 'startedAt', s.started_at) ORDER BY s.started_at, s.id)
      FROM trucker.fleet_suspension s WHERE s.ended_at IS NULL), '[]'::jsonb));
END
$$;

-- Verifies or rejects an ownership claim. Only one claim on a registration can be verified.
--   status: decided | repeated | not_open | conflict | invalid | ownership_conflict
--           | not_independent | unauthorized | forbidden | not_found
CREATE FUNCTION trucker.staff_decide_vehicle_ownership(
  p_token_hash text, p_vehicle uuid, p_expected_version integer, p_decision text, p_reason text,
  p_no_conflict boolean, p_request_id text, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  v trucker.vehicle;
  independence text;
  reasons constant jsonb := '{
    "verified": ["ownership_evidence_accepted"],
    "rejected": ["evidence_not_accepted", "claim_not_upheld"]}';
BEGIN
  SELECT * INTO v FROM trucker.vehicle x WHERE x.id = p_vehicle FOR UPDATE;
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'reviewer', 'staff.fleet_ownership_decide', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF v.id IS NULL OR v.status <> 'active' THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_decision IS NULL OR NOT (reasons ? p_decision) OR p_reason IS NULL OR NOT (reasons -> p_decision ? p_reason) THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF v.ownership <> 'claimed' THEN
    status := CASE WHEN v.ownership = p_decision AND v.ownership_decided_by = entered.staff_id
                        AND v.ownership_reason = p_reason THEN 'repeated' ELSE 'not_open' END;
    RETURN;
  END IF;
  IF v.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  independence := trucker.reviewer_independence(entered.staff_id, v.organisation_id, v.created_by, p_no_conflict);
  IF independence <> 'ok' THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.fleet_ownership_decide', 'refused', NULL,
                                p_request_id, jsonb_build_object('vehicle', v.id, 'reason', independence));
    status := 'not_independent';
    detail := jsonb_build_object('reason', independence);
    RETURN;
  END IF;
  -- Another claim on the same registration is already verified: this one cannot be, and the
  -- existing carrier is not disturbed.
  IF p_decision = 'verified' AND EXISTS (
       SELECT 1 FROM trucker.vehicle w
       WHERE w.registration_country = v.registration_country AND w.registration_number = v.registration_number
         AND w.status = 'active' AND w.ownership = 'verified' AND w.id <> v.id) THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.fleet_ownership_decide', 'refused', NULL,
                                p_request_id, jsonb_build_object('vehicle', v.id, 'reason', 'ownership_conflict'));
    status := 'ownership_conflict';
    RETURN;
  END IF;
  BEGIN
    UPDATE trucker.vehicle x
    SET ownership = p_decision, ownership_decided_by = entered.staff_id, ownership_decided_at = entered.at,
        ownership_reason = p_reason, updated_at = entered.at, row_version = x.row_version + 1
    WHERE x.id = v.id;
  EXCEPTION WHEN unique_violation THEN
    status := 'ownership_conflict';
    RETURN;
  END;
  PERFORM trucker.fleet_audit(entered.at, NULL, entered.staff_id, v.organisation_id, 'vehicle.ownership_decided',
                              'vehicle', v.id, jsonb_build_object('ownership', 'claimed'),
                              jsonb_build_object('ownership', p_decision, 'reason', p_reason));
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.fleet_ownership_decide', 'done', NULL,
                              p_request_id, jsonb_build_object('vehicle', v.id, 'decision', p_decision));
  status := 'decided';
END
$$;

-- Accepts or rejects a document. An accepted one replaces the one accepted before it.
--   status: decided | repeated | not_open | conflict | invalid | not_independent
--           | unauthorized | forbidden | not_found
CREATE FUNCTION trucker.staff_decide_fleet_document(
  p_token_hash text, p_document uuid, p_expected_version integer, p_decision text, p_reason text,
  p_no_conflict boolean, p_request_id text, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.fleet_document;
  independence text;
  reasons constant jsonb := '{
    "accepted": ["document_accepted"],
    "rejected": ["unreadable", "details_mismatch", "not_valid", "not_accepted"]}';
BEGIN
  SELECT * INTO d FROM trucker.fleet_document x WHERE x.id = p_document FOR UPDATE;
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'reviewer', 'staff.fleet_document_decide', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF d.id IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_decision IS NULL OR NOT (reasons ? p_decision) OR p_reason IS NULL OR NOT (reasons -> p_decision ? p_reason) THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF d.status <> 'submitted' THEN
    status := CASE WHEN d.status = p_decision AND d.decided_by = entered.staff_id
                        AND d.decision_reason = p_reason THEN 'repeated' ELSE 'not_open' END;
    RETURN;
  END IF;
  IF d.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  independence := trucker.reviewer_independence(entered.staff_id, d.organisation_id, d.submitted_by, p_no_conflict);
  IF independence <> 'ok' THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.fleet_document_decide', 'refused', NULL,
                                p_request_id, jsonb_build_object('document', d.id, 'reason', independence));
    status := 'not_independent';
    detail := jsonb_build_object('reason', independence);
    RETURN;
  END IF;
  -- A document that has lapsed while it waited cannot be accepted.
  IF p_decision = 'accepted' AND trucker.fleet_document_valid_until(d.expiry_date) <= entered.at THEN
    status := 'invalid';
    detail := jsonb_build_object('reason', 'expired');
    RETURN;
  END IF;
  IF p_decision = 'accepted' THEN
    UPDATE trucker.fleet_document x SET status = 'superseded', row_version = x.row_version + 1
    WHERE coalesce(x.vehicle_id, x.person_id) = coalesce(d.vehicle_id, d.person_id)
      AND x.country_code = d.country_code AND x.type_code = d.type_code AND x.status = 'accepted';
  END IF;
  UPDATE trucker.fleet_document x
  SET status = p_decision, decided_by = entered.staff_id, decided_at = entered.at, decision_reason = p_reason,
      row_version = x.row_version + 1
  WHERE x.id = d.id;
  PERFORM trucker.fleet_audit(entered.at, NULL, entered.staff_id, d.organisation_id, 'fleet_document.decided',
                              'fleet_document', d.id, jsonb_build_object('status', 'submitted'),
                              jsonb_build_object('status', p_decision, 'reason', p_reason));
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.fleet_document_decide', 'done', NULL,
                              p_request_id, jsonb_build_object('document', d.id, 'decision', p_decision));
  status := 'decided';
END
$$;

-- Suspends a vehicle or a driver, or ends the suspension. Takes effect at the next check.
--   p_subject: 'vehicle' with a vehicle id, or 'driver' with a person id
--   status: changed | unchanged | invalid | unauthorized | forbidden | not_found
CREATE FUNCTION trucker.staff_set_fleet_suspension(
  p_token_hash text, p_subject text, p_id uuid, p_suspended boolean, p_reason text, p_request_id text,
  OUT status text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  v_org uuid;
  held trucker.fleet_suspension;
  v_record_type text;
  v_record uuid;
BEGIN
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.fleet_suspend', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF p_suspended IS NULL OR p_subject IS NULL OR p_subject NOT IN ('vehicle', 'driver')
     OR (p_suspended AND (p_reason IS NULL
         OR p_reason NOT IN ('safety_review', 'document_concern', 'suspected_fraud', 'other'))) THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF p_subject = 'vehicle' THEN
    SELECT x.organisation_id, x.id INTO v_org, v_record FROM trucker.vehicle x WHERE x.id = p_id FOR UPDATE;
    v_record_type := 'vehicle';
  ELSE
    -- A driver is known to staff through an affiliation, present or past.
    SELECT x.organisation_id, x.id INTO v_org, v_record FROM trucker.driver_affiliation x
    WHERE x.person_id = p_id ORDER BY (x.status = 'active') DESC, x.invited_at DESC LIMIT 1;
    v_record_type := 'driver_affiliation';
    PERFORM 1 FROM trucker.person p WHERE p.id = p_id FOR UPDATE;
  END IF;
  IF v_org IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO held FROM trucker.fleet_suspension s
  WHERE coalesce(s.vehicle_id, s.person_id) = p_id AND s.subject_kind = p_subject AND s.ended_at IS NULL;
  IF FOUND = p_suspended THEN
    status := 'unchanged';
    RETURN;
  END IF;
  IF p_suspended THEN
    INSERT INTO trucker.fleet_suspension (subject_kind, vehicle_id, person_id, reason, started_at, started_by)
    VALUES (p_subject, CASE WHEN p_subject = 'vehicle' THEN p_id END,
            CASE WHEN p_subject = 'driver' THEN p_id END, p_reason, entered.at, entered.staff_id);
  ELSE
    UPDATE trucker.fleet_suspension s SET ended_at = entered.at, ended_by = entered.staff_id WHERE s.id = held.id;
  END IF;
  PERFORM trucker.fleet_audit(entered.at, NULL, entered.staff_id, v_org,
                              CASE WHEN p_suspended THEN 'fleet.suspended' ELSE 'fleet.suspension_ended' END,
                              v_record_type, v_record, NULL,
                              jsonb_build_object('subject', p_subject, 'reason', coalesce(p_reason, held.reason)));
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.fleet_suspend', 'done', NULL, p_request_id,
                              jsonb_build_object('subject', p_subject, 'id', p_id, 'suspended', p_suspended));
  status := 'changed';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may run what.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.fleet_overview(boolean),
  trucker.register_vehicle(text, jsonb, boolean),
  trucker.retire_vehicle(uuid, integer, text),
  trucker.submit_vehicle_document(uuid, text, jsonb, boolean),
  trucker.invite_driver(text, jsonb),
  trucker.end_driver_affiliation(uuid, integer, text),
  trucker.set_driver_authorisation(uuid, text, jsonb),
  trucker.driver_overview(boolean),
  trucker.respond_driver_invitation(uuid, integer, text, text),
  trucker.leave_driver_affiliation(uuid, integer, text),
  trucker.submit_driver_document(text, jsonb, boolean),
  trucker.staff_fleet_queue(text, text),
  trucker.staff_decide_vehicle_ownership(text, uuid, integer, text, text, boolean, text),
  trucker.staff_decide_fleet_document(text, uuid, integer, text, text, boolean, text),
  trucker.staff_set_fleet_suspension(text, text, uuid, boolean, text, text)
TO trucker_app;
