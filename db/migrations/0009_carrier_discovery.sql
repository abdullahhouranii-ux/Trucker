-- 0009_carrier_discovery
-- Carrier onboarding and discovery. An organisation applies for the carrier capability through
-- the verification flow of 0007, declaring where it operates and which equipment it offers;
-- staff decide. A verified carrier then lists and opens the published shipments it is eligible
-- for, and sees exactly the carrier projection of 0008. Nothing else.
--
-- Decisions recorded on 15 November 2026 (docs/delivery/CARRIER_DISCOVERY_SLICE_11_SCOPE.md):
--   CB-1  the carrier capability is carry_as_company; independent vehicle owners come later;
--   CB-2  one organisation may hold ship and carry_as_company, each decided and revoked on its
--         own; an organisation never discovers its own shipments;
--   CB-3  matching uses the countries and equipment types the carrier declared and staff
--         decided. They are matching criteria only: not verified vehicles, not availability,
--         not permission to accept work;
--   CB-4  a change of declared service is a new application that staff decide; until then the
--         decided declaration stays in force;
--   CB-5  a carrier sees the slice 10 projection of the latest version only;
--   CB-6  administrators of the carrier organisation only;
--   CB-7  carrier reads are kept in an append-only access log that only staff can read; the
--         shipper is not told who looked;
--   CB-8  fictional requirements and demonstration evidence only.
--
-- Shared legal identity. Every capability rests on the legal identity of the application that
-- granted it. A capability counts only while that identity is still the organisation's own
-- (capability_effective below), so no change of identity can silently carry a capability with
-- it. An approved amendment of the identity revalidates, in the same transaction, every
-- capability the organisation held when the amendment was submitted: it must answer the
-- evidence requirements of every one of them in the new country, the reviewer decides it once,
-- and each revalidated capability gets its own history entry. It cannot be approved for one
-- capability and not another: a reviewer who cannot revalidate one requests changes or
-- rejects, and the approved identity stays in force for all (E-2).
--
-- As before: the API's role writes none of this directly, and every function establishes who
-- is asking, takes its locks, reads the database's clock and then decides.

-- ---------------------------------------------------------------------------------------------
-- The carrier capability
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.organisation
  DROP CONSTRAINT organisation_requested_capability_check,
  ADD CONSTRAINT organisation_requested_capability_check
    CHECK (requested_capability IN ('ship', 'carry_as_company'));
ALTER TABLE trucker.evidence_requirement
  DROP CONSTRAINT evidence_requirement_capability_check,
  ADD CONSTRAINT evidence_requirement_capability_check CHECK (capability IN ('ship', 'carry_as_company'));
ALTER TABLE trucker.organisation_capability
  DROP CONSTRAINT organisation_capability_capability_check,
  ADD CONSTRAINT organisation_capability_capability_check CHECK (capability IN ('ship', 'carry_as_company'));

-- initial: the organisation is not verified and applies with its identity for one capability.
-- capability: it is verified, and applies for another capability, or (for carry_as_company,
--             already held) for a change of the declared service. The identity is unchanged.
-- amendment: it is verified and proposes a new legal identity, revalidating every capability
--            it holds (`revalidates`).
ALTER TABLE trucker.verification_application
  DROP CONSTRAINT verification_application_capability_check,
  ADD CONSTRAINT verification_application_capability_check CHECK (capability IN ('ship', 'carry_as_company')),
  DROP CONSTRAINT verification_application_kind_check,
  ADD CONSTRAINT verification_application_kind_check CHECK (kind IN ('initial', 'capability', 'amendment')),
  ADD COLUMN revalidates text[];
UPDATE trucker.verification_application SET revalidates = ARRAY['ship'] WHERE kind = 'amendment';
ALTER TABLE trucker.verification_application
  ADD CONSTRAINT verification_application_revalidates CHECK (
    (kind = 'amendment') = (revalidates IS NOT NULL)
    AND (revalidates IS NULL
         OR (cardinality(revalidates) >= 1 AND revalidates <@ ARRAY['ship', 'carry_as_company'])));

-- The service a carrier declared in an application: where it operates and what it offers.
-- Matching criteria only (CB-3). Never changed after it is written; a change is a new
-- application (CB-4). An amendment carries the declaration in force forward unchanged.
CREATE TABLE trucker.carrier_service_country (
  application_id uuid NOT NULL REFERENCES trucker.verification_application (id),
  country_code text NOT NULL REFERENCES trucker.country (code),
  PRIMARY KEY (application_id, country_code)
);
CREATE TABLE trucker.carrier_service_equipment (
  application_id uuid NOT NULL REFERENCES trucker.verification_application (id),
  equipment_type text NOT NULL REFERENCES trucker.equipment_type (code),
  PRIMARY KEY (application_id, equipment_type)
);
COMMENT ON TABLE trucker.carrier_service_country IS
  'Declared by the carrier; matching criteria only. Not verified operating rights, not availability, not permission to accept work.';
COMMENT ON TABLE trucker.carrier_service_equipment IS
  'Declared by the carrier; matching criteria only. Not verified vehicles, not availability, not permission to accept work.';
ALTER TABLE trucker.carrier_service_country ENABLE ROW LEVEL SECURITY;
CREATE POLICY carrier_service_country_read ON trucker.carrier_service_country FOR SELECT TO trucker_app
  USING (EXISTS (SELECT 1 FROM trucker.verification_application a
                 WHERE a.id = application_id AND a.organisation_id = trucker.request_organisation()
                   AND trucker.is_admin(a.organisation_id)));
ALTER TABLE trucker.carrier_service_equipment ENABLE ROW LEVEL SECURITY;
CREATE POLICY carrier_service_equipment_read ON trucker.carrier_service_equipment FOR SELECT TO trucker_app
  USING (EXISTS (SELECT 1 FROM trucker.verification_application a
                 WHERE a.id = application_id AND a.organisation_id = trucker.request_organisation()
                   AND trucker.is_admin(a.organisation_id)));
GRANT SELECT ON trucker.carrier_service_country, trucker.carrier_service_equipment TO trucker_app;
GRANT SELECT (revalidates) ON trucker.verification_application TO trucker_app;

-- History: a revalidated capability is its own entry.
ALTER TABLE trucker.audit_entry
  DROP CONSTRAINT audit_entry_action_check,
  ADD CONSTRAINT audit_entry_action_check CHECK (action IN (
    'organisation.created', 'organisation.updated',
    'shipment.created', 'shipment.updated', 'shipment.discarded',
    'shipment.published', 'shipment.version_created', 'shipment.withdrawn', 'shipment.expired',
    'shipment.republished', 'shipment.copied', 'shipment.suspended', 'shipment.suspension_ended',
    'verification.submitted', 'verification.withdrawn', 'verification.claim_raised',
    'verification.decided', 'verification.revoked', 'capability.revalidated'));

-- ---------------------------------------------------------------------------------------------
-- Protected settings, development defaults needing production review
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.security_setting
  ADD COLUMN discovery_page_size integer NOT NULL DEFAULT 20 CHECK (discovery_page_size BETWEEN 1 AND 100),
  -- Discovery reads (lists and details) per carrier organisation in any 60 seconds.
  ADD COLUMN discovery_read_limit integer NOT NULL DEFAULT 120 CHECK (discovery_read_limit BETWEEN 1 AND 10000),
  -- How long a list traversal may continue from its first page.
  ADD COLUMN discovery_cursor_hours integer NOT NULL DEFAULT 2 CHECK (discovery_cursor_hours BETWEEN 1 AND 48);
UPDATE trucker.security_setting SET reviewed_for_production = false;

-- ---------------------------------------------------------------------------------------------
-- The access log (CB-7). Staff-only and append-only. It holds who read, when, how, and which
-- shipments were shown, by identifier: never a description, address, area or contact detail.
-- How long it is kept is an unresolved production requirement (SECURITY_BACKLOG.md).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.carrier_access_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  kind text NOT NULL CHECK (kind IN ('list', 'detail')),
  outcome text NOT NULL CHECK (outcome IN ('shown', 'not_found', 'refused')),
  -- detail: the shipment asked for. list: the shipments shown, in order.
  shipment_id uuid,
  shown uuid[] NOT NULL DEFAULT '{}',
  -- Codes only: filter values are country and equipment codes, the refusal a reason code.
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{2,40}$'),
  request_id text CHECK (request_id IS NULL OR length(request_id) <= 200),
  CONSTRAINT carrier_access_log_shape CHECK (
    (kind = 'detail') = (shipment_id IS NOT NULL)
    AND (kind = 'list' OR shown = '{}' OR shown = ARRAY[shipment_id]))
);
CREATE INDEX carrier_access_log_org_idx ON trucker.carrier_access_log (organisation_id, occurred_at);
CREATE INDEX carrier_access_log_shipment_idx ON trucker.carrier_access_log (shipment_id);
CREATE INDEX carrier_access_log_shown_idx ON trucker.carrier_access_log USING gin (shown);
COMMENT ON TABLE trucker.carrier_access_log IS
  'Carrier reads of shipment projections. Staff-only, append-only. Retention not yet decided for production.';

CREATE FUNCTION trucker.guard_carrier_access_log() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a carrier access log entry cannot be changed or removed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER carrier_access_log_guard BEFORE UPDATE OR DELETE ON trucker.carrier_access_log
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_carrier_access_log();
CREATE TRIGGER carrier_access_log_truncate_guard BEFORE TRUNCATE ON trucker.carrier_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_carrier_access_log();
-- Nothing is granted to the API's role: it can neither read nor write the log directly.
ALTER TABLE trucker.carrier_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.carrier_access_log FROM trucker_app, PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Building blocks. None is callable by the API's role.
-- ---------------------------------------------------------------------------------------------

-- Whether an organisation may act on a capability now: verified, the capability granted, not
-- on demonstration evidence in a production database, and the identity it was granted on
-- still the organisation's own. The last condition is what keeps a change of identity from
-- carrying a capability with it.
CREATE FUNCTION trucker.capability_effective(p_organisation uuid, p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM trucker.organisation o
    JOIN trucker.organisation_capability c ON c.organisation_id = o.id
    JOIN trucker.verification_application g ON g.id = c.granted_application
    WHERE o.id = p_organisation
      AND o.status = 'verified'
      AND c.capability = p_capability AND c.status = 'granted'
      AND NOT (c.basis = 'demonstration' AND (SELECT e.kind FROM trucker.environment e) = 'production')
      AND g.legal_name = o.legal_name AND g.country_code = o.country_code
      AND trucker.registration_key(g.country_code, g.registration_number)
          = trucker.registration_key(o.country_code, o.registration_number))
$$;

-- The publication checks of 0007 and 0008, now through the same rule.
CREATE OR REPLACE FUNCTION trucker.organisation_publishable(p_organisation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT trucker.capability_effective(p_organisation, 'ship')
$$;
CREATE OR REPLACE FUNCTION trucker.organisation_may_publish() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT trucker.capability_effective(trucker.request_organisation(), 'ship')
$$;

-- The declaration in force for a carrier: the one in the application that granted (or last
-- revalidated) the capability. Empty arrays when there is none.
CREATE FUNCTION trucker.carrier_service(p_organisation uuid, OUT countries text[], OUT equipment text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT
    coalesce((SELECT array_agg(s.country_code ORDER BY s.country_code)
              FROM trucker.carrier_service_country s WHERE s.application_id = c.granted_application), '{}'),
    coalesce((SELECT array_agg(s.equipment_type ORDER BY s.equipment_type)
              FROM trucker.carrier_service_equipment s WHERE s.application_id = c.granted_application), '{}')
  FROM (SELECT 1 AS one) x
  LEFT JOIN trucker.organisation_capability c
    ON c.organisation_id = p_organisation AND c.capability = 'carry_as_company' AND c.status = 'granted'
$$;

CREATE FUNCTION trucker.application_service(p_application uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM trucker.carrier_service_country s WHERE s.application_id = p_application)
    THEN jsonb_build_object(
      'kind', 'declared_matching_criteria',
      'countries', (SELECT jsonb_agg(s.country_code ORDER BY s.country_code)
                    FROM trucker.carrier_service_country s WHERE s.application_id = p_application),
      'equipmentTypes', coalesce((SELECT jsonb_agg(s.equipment_type ORDER BY s.equipment_type)
                                  FROM trucker.carrier_service_equipment s WHERE s.application_id = p_application),
                                 '[]'::jsonb))
    END
$$;

-- What the history keeps of an application: 0007's values, with what this slice adds.
CREATE OR REPLACE FUNCTION trucker.application_values(a trucker.verification_application) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'versionNo', a.version_no, 'kind', a.kind, 'status', a.status,
    'legalName', a.legal_name, 'countryCode', a.country_code,
    'registrationNumber', a.registration_number, 'capability', a.capability,
    'revalidates', to_jsonb(a.revalidates),
    'service', trucker.application_service(a.id),
    'decisionReason', a.decision_reason,
    'evidence', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'documentType', e.document_type, 'documentNumber', e.document_number,
        'issuingCountry', e.issuing_country, 'issuedOn', e.issued_on, 'expiresOn', e.expires_on)
        ORDER BY e.document_type)
      FROM trucker.verification_evidence e WHERE e.application_id = a.id), '[]'::jsonb))
$$;

-- The evidence an application must answer: the requirements of each capability it is for, in
-- the country of the identity it applies with. A document type asked for by two capabilities
-- is answered once.
CREATE FUNCTION trucker.application_requirements(p_country text, p_capabilities text[])
RETURNS TABLE (document_type text, required boolean, ord integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT r.document_type, bool_or(r.required), min(r.position)
  FROM trucker.evidence_requirement r
  WHERE r.country_code = p_country AND r.capability = ANY (p_capabilities)
  GROUP BY r.document_type
$$;

-- ---------------------------------------------------------------------------------------------
-- Submission, by an administrator of the selected organisation (replaces 0007's).
--   p_content: {"declaration": {...}, "evidence": [...],
--               "capability": "ship" | "carry_as_company",         (initial and capability)
--               "service": {"countries": [...], "equipmentTypes": [...]},  (carry_as_company)
--               "proposed": {"legalName", "countryCode", "registrationNumber"}}  (amendment)
--   A verified organisation sending "proposed" amends its identity; otherwise it applies for a
--   capability (or a new declared service). An organisation that is not verified applies with
--   its identity for one capability.
--   status: submitted | repeated | unauthorized | not_found | conflict | not_open | closed
--           | invalid | key_conflict
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.submit_verification(
  p_key text, p_expected_version integer, p_content jsonb, p_allow_fixtures boolean,
  OUT status text, OUT application_id uuid, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
    IF 'carry_as_company' = ANY (v_capabilities) THEN
      SELECT c.granted_application INTO v_carry_from FROM trucker.organisation_capability c
      WHERE c.organisation_id = org_id AND c.capability = 'carry_as_company';
    END IF;
  ELSE
    v_capability := coalesce(p_content ->> 'capability', org.requested_capability);
    IF v_capability NOT IN ('ship', 'carry_as_company') THEN
      problems := problems || jsonb_build_object('field', 'capability', 'code', 'invalid');
      v_capability := org.requested_capability;
    END IF;
    v_capabilities := ARRAY[v_capability];
    v_name := org.legal_name;
    v_country := org.country_code;
    v_number := org.registration_number;
    IF org.status = 'verified' THEN
      v_kind := 'capability';
      IF v_capability = 'ship' AND EXISTS (
           SELECT 1 FROM trucker.organisation_capability c
           WHERE c.organisation_id = org_id AND c.capability = 'ship' AND c.status = 'granted') THEN
        problems := problems || jsonb_build_object('field', 'capability', 'code', 'already_granted');
      END IF;
    ELSE
      v_kind := 'initial';
    END IF;
    IF NOT trucker.country_available(v_country, p_allow_fixtures) THEN
      status := 'closed';
      RETURN;
    END IF;
    IF p_content ? 'service' AND v_capability <> 'carry_as_company' THEN
      problems := problems || jsonb_build_object('field', 'service', 'code', 'carrier_only');
    END IF;
    IF v_capability = 'carry_as_company' THEN
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
                   WHERE c.organisation_id = org_id AND c.capability = 'carry_as_company' AND c.status = 'granted')
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
  ELSIF v_capability = 'carry_as_company' AND v_kind <> 'amendment' THEN
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

-- ---------------------------------------------------------------------------------------------
-- Staff: the queue now says which capability an application is for.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION trucker.staff_verification_queue(text);
CREATE FUNCTION trucker.staff_verification_queue(p_token_hash text)
RETURNS TABLE (
  application_id uuid, organisation_id uuid, version_no integer, kind text, status text,
  legal_name text, country_code text, submitted_at timestamptz, capability text, revalidates text[]
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT a.id, a.organisation_id, a.version_no, a.kind, a.status, a.legal_name, a.country_code,
         a.submitted_at, a.capability, a.revalidates
  FROM trucker.staff_live_session(p_token_hash) l
  JOIN trucker.verification_application a ON 'reviewer' = ANY (trucker.staff_privileges(l.staff_id))
  WHERE a.status IN ('submitted', 'claim_review')
  ORDER BY a.submitted_at, a.id
  LIMIT 200
$$;

-- One application, with every capability the organisation holds and the declared service.
CREATE OR REPLACE FUNCTION trucker.staff_verification_view(
  p_token_hash text, p_application uuid, p_request_id text,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
      'id', org.id, 'status', org.status, 'legalName', org.legal_name, 'tradingName', org.trading_name,
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

-- The decision (replaces 0007's). What changes is what a "verified" decision grants:
--   initial     the organisation becomes verified with this identity and holds the capability;
--   capability  the organisation holds the capability (or the new declared service); its
--               identity and any other capability are untouched;
--   amendment   the identity changes and every capability in `revalidates` still held is
--               revalidated on it, each with its own history entry.
CREATE OR REPLACE FUNCTION trucker.staff_verification_decide(
  p_token_hash text, p_application uuid, p_expected_version integer, p_decision text,
  p_reason text, p_note text, p_no_conflict boolean, p_request_id text,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  app trucker.verification_application;
  org trucker.organisation;
  before_values jsonb;
  independence text;
  v_cap text;
  held trucker.organisation_capability;
  old_identity jsonb;
  note text := nullif(btrim(coalesce(p_note, '')), '');
  reasons constant jsonb := '{
    "verified": ["evidence_accepted"],
    "changes_requested": ["details_incomplete", "evidence_unclear", "evidence_mismatch", "other"],
    "rejected": ["not_eligible", "evidence_not_accepted", "claim_not_upheld", "other"]}';
BEGIN
  SELECT * INTO app FROM trucker.verification_application a WHERE a.id = p_application FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO org FROM trucker.organisation o WHERE o.id = app.organisation_id FOR UPDATE;
  END IF;
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'reviewer', 'staff.verification_decide', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF app.id IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_decision IS NULL OR NOT (reasons ? p_decision)
     OR p_reason IS NULL OR NOT (reasons -> p_decision ? p_reason) THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF app.status NOT IN ('submitted', 'claim_review') THEN
    IF app.decided_by = entered.staff_id AND app.status = p_decision
       AND app.decision_reason = p_reason AND app.decided_on_version = p_expected_version THEN
      status := 'repeated';
    ELSE
      status := 'not_open';
    END IF;
    RETURN;
  END IF;
  IF app.status = 'claim_review' AND app.claim_raised_by = entered.staff_id
     AND p_decision = 'verified' AND p_reason = 'evidence_accepted'
     AND app.claim_raised_on_version = p_expected_version THEN
    status := 'claim_review';
    detail := jsonb_build_object('repeated', true);
    RETURN;
  END IF;
  IF (note IS NOT NULL AND length(note) > 1000) OR (p_reason = 'other' AND note IS NULL) THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM app.row_version THEN
    status := 'conflict';
    RETURN;
  END IF;

  independence := trucker.reviewer_independence(entered.staff_id, org.id, app.submitted_by, p_no_conflict);
  IF independence <> 'ok' THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_decide', 'refused', NULL,
                                p_request_id,
                                jsonb_build_object('application', app.id, 'reason', independence));
    status := 'not_independent';
    detail := jsonb_build_object('reason', independence);
    RETURN;
  END IF;
  IF app.status = 'claim_review' THEN
    IF NOT ('staff_admin' = ANY (trucker.staff_privileges(entered.staff_id))) THEN
      PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_decide', 'refused', NULL,
                                  p_request_id,
                                  jsonb_build_object('application', app.id, 'reason', 'privilege_not_held',
                                                     'privilege', 'staff_admin'));
      status := 'forbidden';
      RETURN;
    END IF;
    IF app.claim_raised_by = entered.staff_id THEN
      PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_decide', 'refused', NULL,
                                  p_request_id,
                                  jsonb_build_object('application', app.id, 'reason', 'raised_the_claim'));
      status := 'same_person';
      RETURN;
    END IF;
  END IF;

  before_values := trucker.application_values(app);
  PERFORM set_config('trucker.acting_staff', entered.staff_id::text, true);

  IF p_decision = 'verified' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'trucker.verify:' || trucker.registration_key(app.country_code, app.registration_number), 0));
    IF app.status = 'submitted' AND EXISTS (
         SELECT 1 FROM trucker.organisation o
         WHERE o.id <> org.id AND o.status = 'verified'
           AND trucker.registration_key(o.country_code, o.registration_number)
               = trucker.registration_key(app.country_code, app.registration_number)) THEN
      UPDATE trucker.verification_application a
      SET status = 'claim_review', claim_raised_by = entered.staff_id, claim_raised_at = entered.at,
          claim_raised_on_version = a.row_version, row_version = a.row_version + 1
      WHERE a.id = app.id RETURNING * INTO app;
      INSERT INTO trucker.audit_entry
        (occurred_at, actor_staff_id, organisation_id, action, record_type, record_id,
         request_id, before_values, after_values)
      VALUES (entered.at, entered.staff_id, org.id, 'verification.claim_raised', 'verification_application',
              app.id, left(p_request_id, 200), before_values, trucker.application_values(app));
      PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_decide', 'done', NULL,
                                  p_request_id,
                                  jsonb_build_object('application', app.id, 'result', 'claim_review'));
      status := 'claim_review';
      RETURN;
    END IF;
  END IF;

  UPDATE trucker.verification_application a
  SET status = p_decision, decided_by = entered.staff_id, decided_at = entered.at,
      decision_reason = p_reason, decision_note = note, no_conflict_declared = true,
      decided_on_version = a.row_version, row_version = a.row_version + 1
  WHERE a.id = app.id RETURNING * INTO app;

  IF p_decision = 'verified' THEN
    old_identity := jsonb_build_object('legalName', org.legal_name, 'countryCode', org.country_code,
                                       'registrationNumber', org.registration_number);
    UPDATE trucker.organisation o
    SET status = 'verified', legal_name = app.legal_name, country_code = app.country_code,
        registration_number = app.registration_number, version = o.version + 1
    WHERE o.id = org.id;
    IF app.kind = 'amendment' THEN
      -- Every capability held, revalidated on the new identity, each recorded on its own.
      FOREACH v_cap IN ARRAY app.revalidates LOOP
        SELECT * INTO held FROM trucker.organisation_capability c
        WHERE c.organisation_id = org.id AND c.capability = v_cap FOR UPDATE;
        IF NOT FOUND OR held.status <> 'granted' THEN
          CONTINUE;
        END IF;
        UPDATE trucker.organisation_capability c SET granted_application = app.id
        WHERE c.organisation_id = org.id AND c.capability = v_cap;
        INSERT INTO trucker.audit_entry
          (occurred_at, actor_staff_id, organisation_id, action, record_type, record_id,
           request_id, before_values, after_values)
        VALUES (entered.at, entered.staff_id, org.id, 'capability.revalidated', 'verification_application',
                app.id, left(p_request_id, 200),
                jsonb_build_object('capability', v_cap, 'grantedApplication', held.granted_application)
                  || old_identity,
                jsonb_build_object('capability', v_cap, 'grantedApplication', app.id,
                                   'legalName', app.legal_name, 'countryCode', app.country_code,
                                   'registrationNumber', app.registration_number));
      END LOOP;
    ELSE
      INSERT INTO trucker.organisation_capability
        (organisation_id, capability, status, basis, granted_application, granted_at)
      VALUES (org.id, app.capability, 'granted', 'demonstration', app.id, entered.at)
      ON CONFLICT (organisation_id, capability) DO UPDATE
        SET status = 'granted', basis = EXCLUDED.basis, granted_application = EXCLUDED.granted_application,
            granted_at = EXCLUDED.granted_at, revoked_at = NULL, revoked_by = NULL,
            revoke_reason = NULL, revoke_note = NULL;
    END IF;
  ELSIF app.kind = 'initial' THEN
    UPDATE trucker.organisation o SET status = p_decision, version = o.version + 1 WHERE o.id = org.id;
  END IF;
  -- A refused amendment or capability application changes nothing about the organisation.

  INSERT INTO trucker.audit_entry
    (occurred_at, actor_staff_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES (entered.at, entered.staff_id, org.id, 'verification.decided', 'verification_application',
          app.id, left(p_request_id, 200), before_values, trucker.application_values(app));
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_decide', 'done', NULL,
                              p_request_id,
                              jsonb_build_object('application', app.id, 'result', p_decision,
                                                 'reason', p_reason, 'no_conflict_declared', true));
  status := 'decided';
END
$$;

-- Withdrawing one capability given by mistake (E-3, now per capability). The other capability
-- is untouched. The organisation stops being verified only when it holds no capability any
-- more; then an application still under review has nothing left to amend and is withdrawn.
--   status: revoked | repeated | unauthorized | forbidden | not_found | not_verified
--           | not_independent | same_person | invalid
DROP FUNCTION trucker.staff_verification_revoke(text, uuid, text, text, boolean, text);
CREATE FUNCTION trucker.staff_verification_revoke(
  p_token_hash text, p_organisation uuid, p_capability text, p_reason text, p_note text,
  p_no_conflict boolean, p_request_id text,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  IF p_capability IS NULL OR p_capability NOT IN ('ship', 'carry_as_company')
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

-- ---------------------------------------------------------------------------------------------
-- Discovery
--
-- Eligibility is judged at every list and detail request, after the carrier organisation's
-- lock and with the clock read after it, so a request that waited past a deadline or a
-- revocation answers as of the moment it proceeds. Nothing is cached; a cursor is a position,
-- never a permission.
--
-- Snapshot and cursor rules:
--   * A traversal starts at its first page; that moment is its anchor, carried in the cursor.
--   * Order is (deadline, id), where the deadline is the one of the shipment's latest version
--     published at or before the anchor; a shipment first published after the anchor is
--     ordered by its current deadline. So a deadline changed during the traversal does not
--     move the shipment: no duplicate and no skip within one traversal. Its current deadline
--     is shown, and it is marked as changed since the traversal started.
--   * Every page shows only shipments eligible at that page's moment. A shipment withdrawn,
--     expired, suspended or no longer matching disappears, even if an earlier page showed it.
--   * A cursor belongs to one organisation and one filter: used by another organisation or with
--     another filter it is refused. It is refused after `discovery_cursor_hours` too.
-- ---------------------------------------------------------------------------------------------

-- Who is asking, for which carrier organisation, with its lock taken and the clock read after
-- it, and how many reads it made in the last minute.
--   status: ok | unauthorized | not_found | not_carrier | rate_limited
CREATE FUNCTION trucker.discovery_enter(
  OUT status text, OUT actor uuid, OUT org uuid, OUT at timestamptz,
  OUT countries text[], OUT equipment text[]
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  IF NOT trucker.capability_effective(org, 'carry_as_company') THEN
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

-- Whether one shipment is discoverable by a carrier at a moment, judged live: published, not
-- past its deadline, no open suspension, its shipper still eligible to publish, its route open
-- now, not the carrier's own, and inside what the carrier declared.
CREATE FUNCTION trucker.shipment_discoverable(
  d trucker.shipment_draft, p_carrier uuid, p_at timestamptz, p_countries text[], p_equipment text[],
  p_allow_fixtures boolean
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT d.status = 'published'
     AND d.deadline_at > p_at
     AND d.organisation_id <> p_carrier
     AND d.pickup_country = ANY (p_countries)
     AND d.delivery_country = ANY (p_countries)
     AND d.equipment_type = ANY (p_equipment)
     AND NOT EXISTS (SELECT 1 FROM trucker.shipment_suspension s WHERE s.shipment_id = d.id AND s.ended_at IS NULL)
     AND trucker.organisation_publishable(d.organisation_id)
     AND trucker.route_check(d.pickup_country, d.delivery_country, p_allow_fixtures) ->> 'status' = 'open'
$$;

-- The ordering deadline of a shipment within a traversal anchored at p_anchor (see above).
CREATE FUNCTION trucker.discovery_order_deadline(d trucker.shipment_draft, p_anchor timestamptz)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(
    (SELECT (v.carrier_values #>> '{quotationDeadline,at}')::timestamptz
     FROM trucker.shipment_publication_version v
     WHERE v.shipment_id = d.id AND v.created_at <= p_anchor
     ORDER BY v.version_no DESC LIMIT 1),
    d.deadline_at)
$$;

-- What a carrier sees of a shipment: its identifier and the approved projection, nothing more.
CREATE FUNCTION trucker.discovery_item(d trucker.shipment_draft, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object('id', d.id, 'shipment', trucker.shipment_carrier_values(d, p_at))
$$;

-- The list.
--   p_filter: {"pickupCountry"?, "deliveryCountry"?, "equipmentType"?}, codes only.
--   p_cursor: NULL for the first page, else the "next" of the page before, as given.
--   status: ok | unauthorized | not_found | not_carrier | rate_limited | invalid
--           | cursor_invalid | cursor_expired
--   detail (ok): {"items": [{"id", "shipment", "changedSinceStart"}], "next": cursor | null,
--                 "startedAt", "service": {...}}
CREATE FUNCTION trucker.discover_shipments(
  p_filter jsonb, p_cursor jsonb, p_allow_fixtures boolean,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  g trucker.security_setting;
  f jsonb := coalesce(p_filter, '{}'::jsonb);
  f_hash text;
  anchor timestamptz;
  after_deadline timestamptz;
  after_id uuid;
  v_items jsonb;
  more boolean;
  last_deadline timestamptz;
  last_id uuid;
  v_shown uuid[];
  v_key text;
BEGIN
  SELECT * INTO entered FROM trucker.discovery_enter();
  status := entered.status;
  IF status IN ('unauthorized', 'not_found') THEN
    RETURN;
  END IF;
  IF status <> 'ok' THEN
    INSERT INTO trucker.carrier_access_log (occurred_at, organisation_id, person_id, kind, outcome, reason, request_id)
    VALUES (entered.at, entered.org, entered.actor, 'list', 'refused', status,
            left(nullif(current_setting('trucker.request_id', true), ''), 200));
    RETURN;
  END IF;
  SELECT * INTO g FROM trucker.security_setting;

  -- The filter: known keys only, each a code.
  IF jsonb_typeof(f) <> 'object' THEN
    status := 'invalid';
    RETURN;
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(f) LOOP
    IF v_key NOT IN ('pickupCountry', 'deliveryCountry', 'equipmentType')
       OR jsonb_typeof(f -> v_key) <> 'string' OR (f ->> v_key) !~ '^[A-Za-z0-9_]{2,40}$' THEN
      status := 'invalid';
      detail := jsonb_build_object('field', v_key);
      RETURN;
    END IF;
  END LOOP;
  f_hash := trucker.content_hash(f);

  IF p_cursor IS NULL THEN
    anchor := entered.at;
  ELSE
    BEGIN
      IF (p_cursor ->> 'v') IS DISTINCT FROM '1'
         OR (p_cursor ->> 'o') IS DISTINCT FROM entered.org::text
         OR (p_cursor ->> 'f') IS DISTINCT FROM f_hash THEN
        RAISE EXCEPTION 'cursor';
      END IF;
      anchor := (p_cursor ->> 'a')::timestamptz;
      after_deadline := (p_cursor ->> 'd')::timestamptz;
      after_id := (p_cursor ->> 'i')::uuid;
      IF anchor IS NULL OR after_deadline IS NULL OR after_id IS NULL OR anchor > entered.at THEN
        RAISE EXCEPTION 'cursor';
      END IF;
    EXCEPTION WHEN others THEN
      status := 'cursor_invalid';
      RETURN;
    END;
    IF anchor <= entered.at - make_interval(hours => g.discovery_cursor_hours) THEN
      status := 'cursor_expired';
      RETURN;
    END IF;
  END IF;

  WITH eligible AS (
    SELECT d, trucker.discovery_order_deadline(d, anchor) AS key_deadline
    FROM trucker.shipment_draft d
    WHERE d.status = 'published'
      AND (f ->> 'pickupCountry' IS NULL OR d.pickup_country = f ->> 'pickupCountry')
      AND (f ->> 'deliveryCountry' IS NULL OR d.delivery_country = f ->> 'deliveryCountry')
      AND (f ->> 'equipmentType' IS NULL OR d.equipment_type = f ->> 'equipmentType')
      AND trucker.shipment_discoverable(d, entered.org, entered.at, entered.countries, entered.equipment,
                                        p_allow_fixtures)
  ), page AS (
    SELECT e.d, e.key_deadline FROM eligible e
    WHERE after_id IS NULL OR (e.key_deadline, (e.d).id) > (after_deadline, after_id)
    ORDER BY e.key_deadline, (e.d).id
    LIMIT g.discovery_page_size + 1
  ), numbered AS (
    SELECT p.*, row_number() OVER (ORDER BY p.key_deadline, (p.d).id) AS n FROM page p
  )
  SELECT
    coalesce(jsonb_agg(trucker.discovery_item(x.d, entered.at) || jsonb_build_object(
        'changedSinceStart', EXISTS (SELECT 1 FROM trucker.shipment_publication_version v
                                     WHERE v.shipment_id = (x.d).id AND v.created_at > anchor)
                             AND EXISTS (SELECT 1 FROM trucker.shipment_publication_version v
                                         WHERE v.shipment_id = (x.d).id AND v.created_at <= anchor))
      ORDER BY x.n) FILTER (WHERE x.n <= g.discovery_page_size), '[]'::jsonb),
    count(*) > g.discovery_page_size,
    (array_agg(x.key_deadline ORDER BY x.n) FILTER (WHERE x.n <= g.discovery_page_size))[g.discovery_page_size],
    (array_agg((x.d).id ORDER BY x.n) FILTER (WHERE x.n <= g.discovery_page_size))[g.discovery_page_size],
    coalesce(array_agg((x.d).id ORDER BY x.n) FILTER (WHERE x.n <= g.discovery_page_size), '{}')
  INTO v_items, more, last_deadline, last_id, v_shown
  FROM numbered x;

  INSERT INTO trucker.carrier_access_log (occurred_at, organisation_id, person_id, kind, outcome, shown, filter, request_id)
  VALUES (entered.at, entered.org, entered.actor, 'list', 'shown', v_shown, f,
          left(nullif(current_setting('trucker.request_id', true), ''), 200));
  status := 'ok';
  detail := jsonb_build_object(
    'items', v_items,
    'startedAt', anchor,
    'service', jsonb_build_object('kind', 'declared_matching_criteria',
                                  'countries', to_jsonb(entered.countries),
                                  'equipmentTypes', to_jsonb(entered.equipment)),
    'next', CASE WHEN more THEN jsonb_build_object(
      'v', 1, 'o', entered.org, 'f', f_hash, 'a', anchor, 'd', last_deadline, 'i', last_id) END);
END
$$;

-- One shipment. Answers exactly like a shipment that does not exist whenever it is not
-- discoverable by the caller at this moment (CAR-5).
--   status: ok | unauthorized | not_found | not_carrier | rate_limited
CREATE FUNCTION trucker.discover_shipment(
  p_shipment uuid, p_allow_fixtures boolean,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.shipment_draft;
BEGIN
  IF p_shipment IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO entered FROM trucker.discovery_enter();
  status := entered.status;
  IF status IN ('unauthorized', 'not_found') THEN
    RETURN;
  END IF;
  IF status <> 'ok' THEN
    INSERT INTO trucker.carrier_access_log
      (occurred_at, organisation_id, person_id, kind, outcome, shipment_id, reason, request_id)
    VALUES (entered.at, entered.org, entered.actor, 'detail', 'refused', p_shipment, status,
            left(nullif(current_setting('trucker.request_id', true), ''), 200));
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment;
  IF NOT FOUND OR NOT trucker.shipment_discoverable(d, entered.org, entered.at, entered.countries,
                                                     entered.equipment, p_allow_fixtures) THEN
    INSERT INTO trucker.carrier_access_log
      (occurred_at, organisation_id, person_id, kind, outcome, shipment_id, request_id)
    VALUES (entered.at, entered.org, entered.actor, 'detail', 'not_found', p_shipment,
            left(nullif(current_setting('trucker.request_id', true), ''), 200));
    status := 'not_found';
    RETURN;
  END IF;
  INSERT INTO trucker.carrier_access_log
    (occurred_at, organisation_id, person_id, kind, outcome, shipment_id, shown, request_id)
  VALUES (entered.at, entered.org, entered.actor, 'detail', 'shown', d.id, ARRAY[d.id],
          left(nullif(current_setting('trucker.request_id', true), ''), 200));
  status := 'ok';
  detail := trucker.discovery_item(d, entered.at);
END
$$;

-- The carrier's own view of what it may discover: whether it can, and the declared service
-- in force. Nothing is logged: it shows no shipment.
--   status: ok | unauthorized | not_found | not_carrier
CREATE FUNCTION trucker.discovery_status(OUT status text, OUT detail jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  status := CASE WHEN trucker.capability_effective(org, 'carry_as_company') THEN 'ok' ELSE 'not_carrier' END;
  detail := jsonb_build_object('kind', 'declared_matching_criteria',
                               'countries', to_jsonb(s.countries), 'equipmentTypes', to_jsonb(s.equipment));
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff: who read a shipment's projection. Reviewers and staff administrators; each look is
-- recorded in the staff audit.
--   status: ok | unauthorized | forbidden | not_found
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.staff_carrier_access(
  p_token_hash text, p_shipment uuid, p_request_id text,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, NULL, 'staff.carrier_access_view', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT (trucker.staff_privileges(entered.staff_id) && ARRAY['reviewer', 'staff_admin']) THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.carrier_access_view', 'refused', NULL,
                                p_request_id,
                                jsonb_build_object('reason', 'privilege_not_held', 'shipment', p_shipment));
    status := 'forbidden';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trucker.shipment_draft d WHERE d.id = p_shipment AND d.published_version IS NOT NULL) THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.carrier_access_view', 'done', NULL, p_request_id,
                              jsonb_build_object('shipment', p_shipment));
  detail := jsonb_build_object('entries', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'occurredAt', l.occurred_at, 'kind', l.kind, 'outcome', l.outcome,
      'organisation', jsonb_build_object('id', o.id, 'legalName', o.legal_name),
      'person', l.person_id, 'requestId', l.request_id) ORDER BY l.occurred_at DESC, l.id DESC)
    FROM (SELECT * FROM trucker.carrier_access_log x
          WHERE x.shipment_id = p_shipment OR p_shipment = ANY (x.shown)
          ORDER BY x.occurred_at DESC, x.id DESC LIMIT 200) l
    JOIN trucker.organisation o ON o.id = l.organisation_id), '[]'::jsonb));
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may run what.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.staff_verification_queue(text),
  trucker.staff_verification_revoke(text, uuid, text, text, text, boolean, text),
  trucker.discover_shipments(jsonb, jsonb, boolean),
  trucker.discover_shipment(uuid, boolean),
  trucker.discovery_status(),
  trucker.staff_carrier_access(text, uuid, text)
TO trucker_app;
