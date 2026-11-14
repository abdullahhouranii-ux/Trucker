-- 0007_organisation_verification
-- An organisation's administrator submits it for verification with evidence entries; a staff
-- reviewer decides; the applicant sees the outcome and may correct and submit again.
--
-- Decisions recorded on 14 November 2026
-- (docs/delivery/ORGANISATION_VERIFICATION_SLICE_9_SCOPE.md):
--   VD-1  one independent reviewer decides a routine verification;
--   VD-2  a reviewer cannot decide an application they created or belong to;
--   VD-3  a competing registration claim goes to a separate review; the other organisation is
--         neither exposed nor restricted;
--   VD-4  each submission is a new application version; earlier decisions are kept;
--   VD-5  a change to verified legal identity needs a new review;
--   VD-6  evidence requirements are fictional and wording is demonstration only;
--   VD-7  evidence entries are what the applicant declared, never verified documents, and
--         never enable production publication;
--   S-4   independence rests on a declared participant link and a declaration at each
--         decision; "not declared" never means independent;
--   E-1   a competing claim is decided by a different, independent staff member holding both
--         staff_admin and reviewer;
--   E-2   during an amendment review the approved identity stays in force; what is proposed is
--         kept apart and gives no right until approved;
--   E-3   a different staff administrator may withdraw a mistaken verification, with a reason:
--         the capability is revoked in the same transaction, history is kept, nothing else is
--         cancelled;
--   E-4   evidence entries only; no files.
--
-- As before: the API's role writes none of this directly. Each step is a function that
-- establishes who is asking, takes its locks, reads the database's clock and then decides.
-- No publication, quotation, booking or payment exists here.

-- ---------------------------------------------------------------------------------------------
-- States
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.organisation
  DROP CONSTRAINT organisation_status_check,
  ADD CONSTRAINT organisation_status_check CHECK (status IN (
    'draft', 'submitted', 'verified', 'changes_requested', 'rejected', 'verification_withdrawn',
    'suspended', 'closed'));
COMMENT ON COLUMN trucker.organisation.status IS
  'draft, submitted, verified, changes_requested, rejected and verification_withdrawn are reachable. Only verified, with a granted capability, may ever act commercially.';

-- ---------------------------------------------------------------------------------------------
-- What evidence is asked for, by country and capability. Empty after the migrations: no real
-- requirement has been approved for any country. Rows for fictional countries exist only in
-- databases marked local-development or test, because fictional countries exist only there.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.evidence_requirement (
  country_code text NOT NULL REFERENCES trucker.country (code),
  capability text NOT NULL CHECK (capability IN ('ship')),
  document_type text NOT NULL CHECK (document_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 120),
  name_ar text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 120),
  name_ur text NOT NULL CHECK (length(btrim(name_ur)) BETWEEN 1 AND 120),
  required boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 1,
  -- Whether a competent source confirmed this requirement. Nothing has been confirmed yet, so
  -- every row is demonstration only, and the table refuses anything else for now.
  demonstration boolean NOT NULL DEFAULT true CHECK (demonstration),
  PRIMARY KEY (country_code, capability, document_type)
);
COMMENT ON TABLE trucker.evidence_requirement IS
  'Demonstration only. Not a statement of any legal requirement in any country.';
GRANT SELECT ON trucker.evidence_requirement TO trucker_app;

CREATE FUNCTION trucker.guard_evidence_requirement() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trucker.country c WHERE c.code = NEW.country_code AND c.fixture) THEN
    RAISE EXCEPTION 'evidence requirements exist only for fictional countries until real requirements are approved'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER evidence_requirement_guard BEFORE INSERT OR UPDATE ON trucker.evidence_requirement
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_evidence_requirement();

-- ---------------------------------------------------------------------------------------------
-- Applications: one numbered version per submission. A version is a copy of what was
-- submitted and is never changed afterwards, except for its outcome.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.verification_application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  version_no integer NOT NULL CHECK (version_no >= 1),
  -- initial: the organisation is not verified. amendment: it is, and proposes a new identity.
  kind text NOT NULL CHECK (kind IN ('initial', 'amendment')),
  status text NOT NULL CHECK (status IN (
    'submitted', 'claim_review', 'withdrawn', 'verified', 'changes_requested', 'rejected')),
  -- For changes to the outcome only. The content never changes.
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- The legal identity applied for. For an amendment this is what is proposed; it gives no
  -- right until approved (E-2).
  legal_name text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  country_code text NOT NULL REFERENCES trucker.country (code),
  registration_number text NOT NULL CHECK (length(btrim(registration_number)) BETWEEN 1 AND 60),
  capability text NOT NULL CHECK (capability IN ('ship')),
  -- The organisation's state when this was submitted, to return to if it is withdrawn.
  previous_status text NOT NULL,
  submitted_by uuid NOT NULL REFERENCES trucker.person (id),
  submitted_at timestamptz NOT NULL,
  -- The declaration of authority: demonstration wording, with its version and language.
  declaration_kind text NOT NULL CHECK (declaration_kind IN ('demonstration')),
  declaration_version text NOT NULL CHECK (length(declaration_version) BETWEEN 1 AND 40),
  declaration_language text NOT NULL CHECK (declaration_language IN ('en', 'ar', 'ur')),
  withdrawn_at timestamptz,
  -- Competing claim (VD-3): who raised it, by trying to verify.
  claim_raised_by uuid REFERENCES trucker.staff_account (id),
  claim_raised_at timestamptz,
  decided_by uuid REFERENCES trucker.staff_account (id),
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason ~ '^[a-z_]{2,40}$'),
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 1 AND 1000),
  -- The reviewer's declaration, at this decision, of having no connection (S-4).
  no_conflict_declared boolean,
  CONSTRAINT verification_application_once UNIQUE (organisation_id, version_no),
  CONSTRAINT verification_application_decided CHECK (
    (status IN ('verified', 'changes_requested', 'rejected'))
      = (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL
         AND no_conflict_declared IS TRUE)),
  CONSTRAINT verification_application_withdrawn CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CONSTRAINT verification_application_claim CHECK (
    status <> 'claim_review' OR (claim_raised_by IS NOT NULL AND claim_raised_at IS NOT NULL))
);
-- One open version at a time.
CREATE UNIQUE INDEX verification_application_one_open ON trucker.verification_application (organisation_id)
  WHERE status IN ('submitted', 'claim_review');
CREATE INDEX verification_application_queue_idx ON trucker.verification_application (status, submitted_at);

COMMENT ON TABLE trucker.verification_application IS
  'What an organisation submitted for verification, and its outcome. The content is what the applicant declared; it is not a verified document.';

-- Evidence entries: typed by the applicant. Declared, not verified; demonstration only.
CREATE TABLE trucker.verification_evidence (
  application_id uuid NOT NULL REFERENCES trucker.verification_application (id),
  document_type text NOT NULL,
  document_number text NOT NULL CHECK (length(btrim(document_number)) BETWEEN 1 AND 80),
  issuing_country text NOT NULL REFERENCES trucker.country (code),
  issued_on date,
  expires_on date,
  PRIMARY KEY (application_id, document_type),
  CONSTRAINT verification_evidence_dates CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on > issued_on)
);
COMMENT ON TABLE trucker.verification_evidence IS
  'Entries declared by the applicant. Never presented as verified documents. No file is held.';

-- What a verified organisation may do, and on what basis it was granted.
CREATE TABLE trucker.organisation_capability (
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  capability text NOT NULL CHECK (capability IN ('ship')),
  status text NOT NULL CHECK (status IN ('granted', 'revoked')),
  -- Only demonstration evidence exists. A capability granted on it never allows publication
  -- in a production database (VD-7).
  basis text NOT NULL CHECK (basis IN ('demonstration')),
  granted_application uuid NOT NULL REFERENCES trucker.verification_application (id),
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES trucker.staff_account (id),
  revoke_reason text CHECK (revoke_reason ~ '^[a-z_]{2,40}$'),
  revoke_note text CHECK (revoke_note IS NULL OR length(revoke_note) BETWEEN 1 AND 1000),
  PRIMARY KEY (organisation_id, capability),
  CONSTRAINT organisation_capability_revoked CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL))
);

CREATE TABLE trucker.verification_retry_key (
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9._-]{16,128}$'),
  operation text NOT NULL CHECK (operation IN ('submit', 'withdraw')),
  request_hash text NOT NULL,
  application_id uuid NOT NULL REFERENCES trucker.verification_application (id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (person_id, key)
);

-- ---------------------------------------------------------------------------------------------
-- History. An entry is now made either by a participant or by a staff member, never by nobody.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.audit_entry
  ALTER COLUMN actor_person_id DROP NOT NULL,
  ADD COLUMN actor_staff_id uuid REFERENCES trucker.staff_account (id),
  ADD CONSTRAINT audit_entry_one_actor CHECK ((actor_person_id IS NULL) <> (actor_staff_id IS NULL)),
  DROP CONSTRAINT audit_entry_action_check,
  ADD CONSTRAINT audit_entry_action_check CHECK (action IN (
    'organisation.created', 'organisation.updated',
    'shipment.created', 'shipment.updated', 'shipment.discarded',
    'verification.submitted', 'verification.withdrawn', 'verification.claim_raised',
    'verification.decided', 'verification.revoked')),
  DROP CONSTRAINT audit_entry_record_type_check,
  ADD CONSTRAINT audit_entry_record_type_check CHECK (record_type IN (
    'organisation', 'shipment_draft', 'verification_application'));

-- The staff member on whose behalf a staff function is changing an organisation, for the
-- history. Set only by the functions below, for their own transaction. A request by the API's
-- role cannot use it to pass as staff: its own changes are allowed by row security only for a
-- signed-in administrator, who is then the recorded actor.
CREATE FUNCTION trucker.acting_staff() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  named text := nullif(current_setting('trucker.acting_staff', true), '');
BEGIN
  IF named IS NULL OR named !~ '^[0-9a-f-]{36}$' THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT a.id FROM trucker.staff_account a WHERE a.id = named::uuid);
END
$$;

CREATE OR REPLACE FUNCTION trucker.audit_organisation_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  actor uuid := trucker.request_person();
  staff uuid;
BEGIN
  IF actor IS NULL THEN
    staff := trucker.acting_staff();
    IF staff IS NULL THEN
      RAISE EXCEPTION 'an organisation cannot be changed without a signed-in person or staff member'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'each change must raise the version by one' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES
    (NEW.updated_at, actor, staff, NEW.id, 'organisation.updated', 'organisation', NEW.id,
     nullif(current_setting('trucker.request_id', true), ''),
     trucker.organisation_values(OLD), trucker.organisation_values(NEW));
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- What an administrator may change directly, by state.
--   draft, changes_requested, rejected, verification_withdrawn: everything, as before.
--   submitted: nothing. What was submitted is under review.
--   verified: everything except the legal identity, which changes only through an approved
--             amendment (VD-5). The guard below enforces that for the API's role.
-- ---------------------------------------------------------------------------------------------
DROP POLICY organisation_change ON trucker.organisation;
CREATE POLICY organisation_change ON trucker.organisation FOR UPDATE TO trucker_app
  USING (id = trucker.request_organisation() AND trucker.is_admin(id)
         AND status IN ('draft', 'changes_requested', 'rejected', 'verification_withdrawn', 'verified'))
  WITH CHECK (id = trucker.request_organisation() AND trucker.is_admin(id)
              AND status IN ('draft', 'changes_requested', 'rejected', 'verification_withdrawn', 'verified'));

-- Runs with the rights of whoever makes the change, so that it can tell the API's role, which
-- is bound here, from the functions below, which run as the tables' owner.
CREATE FUNCTION trucker.guard_verified_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF OLD.status = 'verified'
     AND (NEW.legal_name IS DISTINCT FROM OLD.legal_name
          OR NEW.country_code IS DISTINCT FROM OLD.country_code
          OR NEW.registration_number IS DISTINCT FROM OLD.registration_number)
     AND pg_has_role(current_user, 'trucker_app', 'MEMBER')
     AND NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
    RAISE EXCEPTION 'the legal identity of a verified organisation changes only through an approved amendment'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER organisation_identity_guard BEFORE UPDATE ON trucker.organisation
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_verified_identity();

-- ---------------------------------------------------------------------------------------------
-- Row security: an applicant reads the applications, entries and capabilities of the one
-- organisation the request selected, as its administrator. Nothing is written directly.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.evidence_requirement ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_requirement_read ON trucker.evidence_requirement FOR SELECT TO trucker_app USING (true);
ALTER TABLE trucker.verification_application ENABLE ROW LEVEL SECURITY;
CREATE POLICY verification_application_read ON trucker.verification_application FOR SELECT TO trucker_app
  USING (organisation_id = trucker.request_organisation() AND trucker.is_admin(organisation_id));
ALTER TABLE trucker.verification_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY verification_evidence_read ON trucker.verification_evidence FOR SELECT TO trucker_app
  USING (EXISTS (SELECT 1 FROM trucker.verification_application a
                 WHERE a.id = application_id
                   AND a.organisation_id = trucker.request_organisation()
                   AND trucker.is_admin(a.organisation_id)));
ALTER TABLE trucker.organisation_capability ENABLE ROW LEVEL SECURITY;
CREATE POLICY organisation_capability_read ON trucker.organisation_capability FOR SELECT TO trucker_app
  USING (organisation_id = trucker.request_organisation());
ALTER TABLE trucker.verification_retry_key ENABLE ROW LEVEL SECURITY;
-- The applicant never sees which staff member decided: only that staff did.
GRANT SELECT (id, organisation_id, version_no, kind, status, row_version, legal_name, country_code,
              registration_number, capability, submitted_at, declaration_kind, declaration_version,
              declaration_language, withdrawn_at, decided_at, decision_reason, decision_note)
  ON trucker.verification_application TO trucker_app;
GRANT SELECT ON trucker.verification_evidence TO trucker_app;
GRANT SELECT (organisation_id, capability, status, basis, granted_at, revoked_at, revoke_reason, revoke_note)
  ON trucker.organisation_capability TO trucker_app;

-- ---------------------------------------------------------------------------------------------
-- Building blocks. None is callable by the API's role.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.application_values(a trucker.verification_application) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'versionNo', a.version_no, 'kind', a.kind, 'status', a.status,
    'legalName', a.legal_name, 'countryCode', a.country_code,
    'registrationNumber', a.registration_number, 'capability', a.capability,
    'decisionReason', a.decision_reason,
    'evidence', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'documentType', e.document_type, 'documentNumber', e.document_number,
        'issuingCountry', e.issuing_country, 'issuedOn', e.issued_on, 'expiresOn', e.expires_on)
        ORDER BY e.document_type)
      FROM trucker.verification_evidence e WHERE e.application_id = a.id), '[]'::jsonb))
$$;

-- A registration number as compared between organisations: case and spacing do not make two
-- numbers different.
CREATE FUNCTION trucker.registration_key(p_country text, p_number text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_country || ':' || upper(regexp_replace(coalesce(p_number, ''), '[[:space:]]+', '', 'g'))
$$;

-- Whether a staff member may decide about an organisation (VD-2, S-4). Nothing is assumed:
--   ok | link_not_declared | connected | conflict_not_declared
CREATE FUNCTION trucker.reviewer_independence(
  p_staff uuid, p_organisation uuid, p_submitted_by uuid, p_no_conflict boolean
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  account trucker.staff_account;
BEGIN
  SELECT * INTO account FROM trucker.staff_account a WHERE a.id = p_staff;
  IF NOT FOUND OR account.participant_link = 'not_declared' THEN
    RETURN 'link_not_declared';
  END IF;
  IF account.participant_link = 'declared' AND EXISTS (
       SELECT 1 FROM trucker.person p
       WHERE p.phone_e164 = account.participant_phone
         AND (p.id = p_submitted_by
              OR EXISTS (SELECT 1 FROM trucker.organisation o WHERE o.id = p_organisation AND o.created_by = p.id)
              -- A membership counts whether or not it has ended.
              OR EXISTS (SELECT 1 FROM trucker.membership m
                         WHERE m.organisation_id = p_organisation AND m.person_id = p.id)
              OR EXISTS (SELECT 1 FROM trucker.verification_application v
                         WHERE v.organisation_id = p_organisation AND v.submitted_by = p.id))) THEN
    RETURN 'connected';
  END IF;
  IF p_no_conflict IS NOT TRUE THEN
    RETURN 'conflict_not_declared';
  END IF;
  RETURN 'ok';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The publication check, for later slices. Yes only for a verified organisation holding a
-- granted "ship" capability, and in a production database never when that capability rests on
-- demonstration evidence. Answers for the organisation the request selected.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.organisation_may_publish() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM trucker.organisation o
    JOIN trucker.organisation_capability c ON c.organisation_id = o.id
    WHERE o.id = trucker.request_organisation()
      AND o.status = 'verified'
      AND c.capability = 'ship' AND c.status = 'granted'
      AND NOT (c.basis = 'demonstration' AND (SELECT e.kind FROM trucker.environment e) = 'production'))
$$;

-- ---------------------------------------------------------------------------------------------
-- Submission, by an administrator of the selected organisation.
--   p_content: {"declaration": {"accepted": true, "version": "...", "language": "en"},
--               "proposed": {"legalName", "countryCode", "registrationNumber"}   (amendment only)
--               "evidence": [{"documentType", "documentNumber", "issuingCountry", "issuedOn", "expiresOn"}]}
--   status: submitted | repeated | unauthorized | not_found | conflict | not_open | closed
--           | invalid | key_conflict
--   closed: no evidence requirement exists for the country, so nothing can be verified there.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.submit_verification(
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
  v_name text;
  v_country text;
  v_number text;
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
  -- After any wait: still signed in, still an administrator, and what time it is now.
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

  IF org.status = 'verified' THEN
    v_kind := 'amendment';
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
  ELSE
    v_kind := 'initial';
    v_name := org.legal_name;
    v_country := org.country_code;
    v_number := org.registration_number;
    IF NOT trucker.country_available(v_country, p_allow_fixtures) THEN
      status := 'closed';
      RETURN;
    END IF;
  END IF;

  -- Nothing can be verified where no requirement exists.
  IF problems = '[]'::jsonb AND NOT EXISTS (
       SELECT 1 FROM trucker.evidence_requirement r
       WHERE r.country_code = v_country AND r.capability = org.requested_capability) THEN
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
      IF NOT EXISTS (SELECT 1 FROM trucker.evidence_requirement r
                     WHERE r.country_code = v_country AND r.capability = org.requested_capability
                       AND r.document_type = v_type) OR v_type = ANY (seen) THEN
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
    -- Every required entry must be there.
    FOR v_type IN
      SELECT r.document_type FROM trucker.evidence_requirement r
      WHERE r.country_code = v_country AND r.capability = org.requested_capability AND r.required
      ORDER BY r.position, r.document_type
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
     capability, previous_status, submitted_by, submitted_at,
     declaration_kind, declaration_version, declaration_language)
  VALUES
    (org_id, next_no, v_kind, 'submitted', v_name, v_country, v_number,
     org.requested_capability, org.status, actor, t,
     'demonstration', p_content #>> '{declaration,version}', p_content #>> '{declaration,language}')
  RETURNING * INTO made;
  INSERT INTO trucker.verification_evidence
    (application_id, document_type, document_number, issuing_country, issued_on, expires_on)
  SELECT made.id, e ->> 'documentType', btrim(e ->> 'documentNumber'), e ->> 'issuingCountry',
         nullif(e ->> 'issuedOn', '')::date, nullif(e ->> 'expiresOn', '')::date
  FROM jsonb_array_elements(p_content -> 'evidence') e;
  -- An organisation that is not verified is now under review and locked. A verified one stays
  -- verified under its approved identity (E-2).
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

-- Withdrawal by the applicant, while the application is open.
--   status: withdrawn | repeated | unauthorized | not_found | not_open | key_conflict
CREATE FUNCTION trucker.withdraw_verification(p_application uuid, p_key text, OUT status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org_id uuid;
  org trucker.organisation;
  app trucker.verification_application;
  earlier trucker.verification_retry_key;
  g trucker.security_setting;
  t timestamptz;
  before_values jsonb;
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
  SELECT * INTO app FROM trucker.verification_application a
  WHERE a.id = p_application AND a.organisation_id = org_id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
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
  SELECT * INTO earlier FROM trucker.verification_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  IF FOUND AND earlier.created_at > t - make_interval(hours => g.retry_key_retention_hours) THEN
    IF earlier.operation <> 'withdraw' OR earlier.application_id <> app.id THEN
      status := 'key_conflict';
      RETURN;
    END IF;
    status := 'repeated';
    RETURN;
  END IF;
  IF FOUND THEN
    DELETE FROM trucker.verification_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  END IF;
  IF app.status NOT IN ('submitted', 'claim_review') THEN
    status := 'not_open';
    RETURN;
  END IF;
  before_values := trucker.application_values(app);
  UPDATE trucker.verification_application a
  SET status = 'withdrawn', withdrawn_at = t, row_version = a.row_version + 1
  WHERE a.id = app.id RETURNING * INTO app;
  IF app.kind = 'initial' THEN
    UPDATE trucker.organisation o SET status = app.previous_status, version = o.version + 1 WHERE o.id = org_id;
  END IF;
  INSERT INTO trucker.verification_retry_key (person_id, key, operation, request_hash, application_id, created_at)
  VALUES (actor, p_key, 'withdraw', '', app.id, t);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES
    (t, actor, org_id, 'verification.withdrawn', 'verification_application', app.id,
     nullif(current_setting('trucker.request_id', true), ''), before_values, trucker.application_values(app));
  status := 'withdrawn';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff: the queue, one application, the decision, the withdrawal of a verification.
-- ---------------------------------------------------------------------------------------------

-- Open applications, oldest first. Nothing for a caller who is not a reviewer.
CREATE FUNCTION trucker.staff_verification_queue(p_token_hash text)
RETURNS TABLE (
  application_id uuid, organisation_id uuid, version_no integer, kind text, status text,
  legal_name text, country_code text, submitted_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT a.id, a.organisation_id, a.version_no, a.kind, a.status, a.legal_name, a.country_code,
         a.submitted_at
  FROM trucker.staff_live_session(p_token_hash) l
  JOIN trucker.verification_application a ON 'reviewer' = ANY (trucker.staff_privileges(l.staff_id))
  WHERE a.status IN ('submitted', 'claim_review')
  ORDER BY a.submitted_at, a.id
  LIMIT 200
$$;

-- One application with everything a reviewer needs, and nothing about any other organisation.
-- Each look is recorded. `competing` says only whether the same registration number is
-- already verified for some other organisation, never which.
--   status: ok | unauthorized | forbidden | not_found
CREATE FUNCTION trucker.staff_verification_view(
  p_token_hash text, p_application uuid, p_request_id text,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  app trucker.verification_application;
  org trucker.organisation;
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
      'capability', (SELECT jsonb_build_object('status', c.status, 'basis', c.basis, 'grantedAt', c.granted_at,
                                               'grantedByCaller', g.decided_by IS NOT DISTINCT FROM entered.staff_id)
                     FROM trucker.organisation_capability c
                     JOIN trucker.verification_application g ON g.id = c.granted_application
                     WHERE c.organisation_id = org.id AND c.capability = 'ship')),
    'requirements', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'documentType', r.document_type, 'name', r.name_en, 'required', r.required)
        ORDER BY r.position, r.document_type)
      FROM trucker.evidence_requirement r
      WHERE r.country_code = app.country_code AND r.capability = app.capability), '[]'::jsonb),
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

-- The decision. One reviewer decides a routine application (VD-1). A decision to verify an
-- application whose registration number is already verified for another organisation does not
-- verify: it moves the application to claim review (VD-3), which a different, independent
-- staff member holding both privileges decides (E-1).
--   p_decision: verified | changes_requested | rejected
--   status: decided | repeated | claim_review | unauthorized | forbidden | not_found | conflict
--           | not_open | not_independent | same_person | invalid
CREATE FUNCTION trucker.staff_verification_decide(
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
  note text := nullif(btrim(coalesce(p_note, '')), '');
  reasons constant jsonb := '{
    "verified": ["evidence_accepted"],
    "changes_requested": ["details_incomplete", "evidence_unclear", "evidence_mismatch", "other"],
    "rejected": ["not_eligible", "evidence_not_accepted", "claim_not_upheld", "other"]}';
BEGIN
  -- Locks first, in one order everywhere: the application, then its organisation.
  SELECT * INTO app FROM trucker.verification_application a WHERE a.id = p_application FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO org FROM trucker.organisation o WHERE o.id = app.organisation_id FOR UPDATE;
  END IF;
  -- Then who is asking, with the clock read after every lock.
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
     OR p_reason IS NULL OR NOT (reasons -> p_decision ? p_reason)
     OR (note IS NOT NULL AND length(note) > 1000)
     -- "Other" says nothing by itself: it needs the note.
     OR (p_reason = 'other' AND note IS NULL) THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF app.status NOT IN ('submitted', 'claim_review') THEN
    -- The same decision by the same person again: the answer to the first was lost.
    IF app.decided_by = entered.staff_id AND app.status = p_decision AND app.decision_reason = p_reason THEN
      status := 'repeated';
    ELSE
      status := 'not_open';
    END IF;
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
    -- One verification at a time for one registration number, so that two organisations with
    -- the same number cannot both be verified as routine at the same moment.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'trucker.verify:' || trucker.registration_key(app.country_code, app.registration_number), 0));
    IF app.status = 'submitted' AND EXISTS (
         SELECT 1 FROM trucker.organisation o
         WHERE o.id <> org.id AND o.status = 'verified'
           AND trucker.registration_key(o.country_code, o.registration_number)
               = trucker.registration_key(app.country_code, app.registration_number)) THEN
      UPDATE trucker.verification_application a
      SET status = 'claim_review', claim_raised_by = entered.staff_id, claim_raised_at = entered.at,
          row_version = a.row_version + 1
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
      row_version = a.row_version + 1
  WHERE a.id = app.id RETURNING * INTO app;

  IF p_decision = 'verified' THEN
    -- The approved identity takes effect now, in the same step as the grant (E-2).
    UPDATE trucker.organisation o
    SET status = 'verified', legal_name = app.legal_name, country_code = app.country_code,
        registration_number = app.registration_number, version = o.version + 1
    WHERE o.id = org.id;
    INSERT INTO trucker.organisation_capability
      (organisation_id, capability, status, basis, granted_application, granted_at)
    VALUES (org.id, app.capability, 'granted', 'demonstration', app.id, entered.at)
    ON CONFLICT (organisation_id, capability) DO UPDATE
      SET status = 'granted', basis = EXCLUDED.basis, granted_application = EXCLUDED.granted_application,
          granted_at = EXCLUDED.granted_at, revoked_at = NULL, revoked_by = NULL,
          revoke_reason = NULL, revoke_note = NULL;
  ELSIF app.kind = 'initial' THEN
    UPDATE trucker.organisation o SET status = p_decision, version = o.version + 1 WHERE o.id = org.id;
  END IF;
  -- A refused amendment changes nothing about the organisation.

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

-- Withdrawing a verification that was given by mistake (E-3). By a staff administrator who
-- did not give it and is independent of the organisation. The organisation stops being
-- verified and loses the capability in this one transaction; every application, entry and
-- decision stays; nothing else is touched.
--   status: revoked | repeated | unauthorized | forbidden | not_found | not_verified
--           | not_independent | same_person | invalid
CREATE FUNCTION trucker.staff_verification_revoke(
  p_token_hash text, p_organisation uuid, p_reason text, p_note text, p_no_conflict boolean,
  p_request_id text,
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
  IF p_reason IS NULL OR p_reason NOT IN ('verified_in_error', 'information_changed', 'other')
     OR (note IS NOT NULL AND length(note) > 1000) OR (p_reason = 'other' AND note IS NULL) THEN
    status := 'invalid';
    RETURN;
  END IF;
  SELECT * INTO held FROM trucker.organisation_capability c
  WHERE c.organisation_id = org.id AND c.capability = 'ship' FOR UPDATE;
  IF org.status <> 'verified' OR NOT FOUND OR held.status <> 'granted' THEN
    IF FOUND AND held.status = 'revoked' AND held.revoked_by = entered.staff_id
       AND held.revoke_reason = p_reason AND org.status = 'verification_withdrawn' THEN
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
                                jsonb_build_object('organisation', org.id, 'reason', 'gave_the_verification'));
    status := 'same_person';
    RETURN;
  END IF;
  independence := trucker.reviewer_independence(entered.staff_id, org.id, granted.submitted_by, p_no_conflict);
  IF independence <> 'ok' THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_revoke', 'refused', NULL,
                                p_request_id,
                                jsonb_build_object('organisation', org.id, 'reason', independence));
    status := 'not_independent';
    detail := jsonb_build_object('reason', independence);
    RETURN;
  END IF;

  PERFORM set_config('trucker.acting_staff', entered.staff_id::text, true);
  UPDATE trucker.organisation_capability c
  SET status = 'revoked', revoked_at = entered.at, revoked_by = entered.staff_id,
      revoke_reason = p_reason, revoke_note = note
  WHERE c.organisation_id = org.id AND c.capability = 'ship';
  UPDATE trucker.organisation o SET status = 'verification_withdrawn', version = o.version + 1
  WHERE o.id = org.id;
  -- An amendment still under review has nothing left to amend.
  IF open_one.id IS NOT NULL THEN
    UPDATE trucker.verification_application a
    SET status = 'withdrawn', withdrawn_at = entered.at, row_version = a.row_version + 1
    WHERE a.id = open_one.id;
  END IF;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_staff_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES (entered.at, entered.staff_id, org.id, 'verification.revoked', 'verification_application',
          granted.id, left(p_request_id, 200),
          jsonb_build_object('capability', 'ship', 'status', 'granted'),
          jsonb_build_object('capability', 'ship', 'status', 'revoked', 'reason', p_reason));
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.verification_revoke', 'done', NULL,
                              p_request_id,
                              jsonb_build_object('organisation', org.id, 'reason', p_reason,
                                                 'no_conflict_declared', true));
  status := 'revoked';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may run what.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.organisation_may_publish(),
  trucker.submit_verification(text, integer, jsonb, boolean),
  trucker.withdraw_verification(uuid, text),
  trucker.staff_verification_queue(text),
  trucker.staff_verification_view(text, uuid, text),
  trucker.staff_verification_decide(text, uuid, integer, text, text, text, boolean, text),
  trucker.staff_verification_revoke(text, uuid, text, text, boolean, text)
TO trucker_app;
REVOKE ALL ON trucker.verification_retry_key FROM trucker_app, PUBLIC;
