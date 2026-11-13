-- 0003_organisations
-- Organisations, membership, audit history, safe-retry keys, an empty country register, and
-- the database role the API runs as.
--
-- Decisions recorded on 13 November 2026 (docs/delivery/ORGANISATION_ONBOARDING_SLICE_5.md):
--   * shipper organisations only in this slice; a draft grants no ownership or commercial right;
--   * the same registration number may appear on several drafts; verification resolves it;
--   * no real country is enabled here. Fixture countries exist only in a database that has
--     been marked as a local development or test database (see trucker.environment).
--
-- Who is asking is decided by the database, not by the API. The API passes the hash of the
-- session token; the functions below find the live session and its person themselves. A
-- forged person or organisation identifier therefore selects nothing. And membership is not
-- enough to read: a request sees only the one organisation it selected.

-- ---------------------------------------------------------------------------------------------
-- The API's role. No login of its own: an operator creates a login role that is a member.
-- It owns nothing, is not a superuser and cannot bypass row security.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trucker_app') THEN
    CREATE ROLE trucker_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
EXCEPTION
  -- Another database on the same server created it at the same moment.
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

GRANT USAGE ON SCHEMA trucker TO trucker_app;

-- Identity tables (0002): what the sign-in and session code already does, and no more.
-- Nothing is deleted; identity events are append-only.
GRANT SELECT, INSERT, UPDATE ON trucker.person, trucker.session, trucker.sign_in_challenge
  TO trucker_app;
GRANT SELECT, INSERT ON trucker.terms_acceptance, trucker.identity_event TO trucker_app;
GRANT SELECT ON public.schema_migrations TO trucker_app;

-- ---------------------------------------------------------------------------------------------
-- What kind of database this is. One row. The mark moves one way only:
--   unmarked -> local-development | test | production, and never away from production.
-- Fixture data is refused unless the mark is local-development or test.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  kind text NOT NULL DEFAULT 'unmarked'
    CHECK (kind IN ('unmarked', 'local-development', 'test', 'production')),
  marked_at timestamptz
);
INSERT INTO trucker.environment (singleton) VALUES (true);
GRANT SELECT ON trucker.environment TO trucker_app;

-- ---------------------------------------------------------------------------------------------
-- Country register. Ships empty: no country is approved (D-003b). A fixture country must use
-- a code reserved for private use, so it can never be, or collide with, a real country.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.country (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 80),
  name_ar text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 80),
  name_ur text NOT NULL CHECK (length(btrim(name_ur)) BETWEEN 1 AND 80),
  registration_state text NOT NULL DEFAULT 'closed'
    CHECK (registration_state IN ('closed', 'enabled')),
  fixture boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT country_fixture_uses_private_code
    CHECK (fixture = (code ~ '^(AA|Q[M-Z]|X[A-Z]|ZZ)$'))
);
GRANT SELECT ON trucker.country TO trucker_app;

CREATE FUNCTION trucker.guard_country() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_kind text;
BEGIN
  SELECT kind INTO current_kind FROM trucker.environment;
  IF NEW.fixture AND current_kind NOT IN ('local-development', 'test') THEN
    RAISE EXCEPTION 'fixture countries are allowed only in a database marked local-development or test (this one is %)', current_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER country_guard BEFORE INSERT OR UPDATE ON trucker.country
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_country();

CREATE FUNCTION trucker.guard_environment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the environment mark cannot be removed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'production' AND NEW.kind <> 'production' THEN
    RAISE EXCEPTION 'a production database cannot be re-marked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'unmarked' AND OLD.kind <> 'unmarked' THEN
    RAISE EXCEPTION 'a marked database cannot be unmarked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind NOT IN ('local-development', 'test')
     AND EXISTS (SELECT 1 FROM trucker.country WHERE fixture) THEN
    RAISE EXCEPTION 'this database holds fixture countries and cannot be marked %', NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER environment_guard BEFORE UPDATE OR DELETE ON trucker.environment
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_environment();

-- ---------------------------------------------------------------------------------------------
-- Organisations and membership
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.organisation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'verified', 'changes_requested', 'rejected', 'suspended', 'closed')),
  requested_capability text NOT NULL DEFAULT 'ship' CHECK (requested_capability IN ('ship')),
  legal_name text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  trading_name text CHECK (trading_name IS NULL OR length(btrim(trading_name)) BETWEEN 1 AND 200),
  country_code text NOT NULL REFERENCES trucker.country (code),
  registration_number text NOT NULL CHECK (length(btrim(registration_number)) BETWEEN 1 AND 60),
  address text CHECK (address IS NULL OR length(btrim(address)) BETWEEN 1 AND 500),
  contact_name text CHECK (contact_name IS NULL OR length(btrim(contact_name)) BETWEEN 1 AND 120),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES trucker.person (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
-- Deliberately not unique: several drafts may carry the same number (decision O-1).
CREATE INDEX organisation_registration_idx
  ON trucker.organisation (country_code, registration_number);
CREATE INDEX organisation_created_by_idx ON trucker.organisation (created_by);

COMMENT ON COLUMN trucker.organisation.status IS
  'Only draft is reachable in this slice. A draft grants no ownership or commercial right.';
COMMENT ON COLUMN trucker.organisation.requested_capability IS
  'What was asked for, not what is granted. Capabilities are granted only by a compliance decision.';
COMMENT ON INDEX trucker.organisation_registration_idx IS
  'Not unique on purpose. Competing claims on a registration number are resolved at verification.';

CREATE TABLE trucker.membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  role text NOT NULL CHECK (role IN ('admin')),
  created_at timestamptz NOT NULL,
  ended_at timestamptz,
  CONSTRAINT membership_once UNIQUE (organisation_id, person_id)
);
CREATE INDEX membership_person_idx ON trucker.membership (person_id);

-- ---------------------------------------------------------------------------------------------
-- Audit history: written only by the database itself, never changed, never deleted.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.audit_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL,
  actor_person_id uuid NOT NULL REFERENCES trucker.person (id),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  action text NOT NULL CHECK (action IN ('organisation.created', 'organisation.updated')),
  record_type text NOT NULL CHECK (record_type IN ('organisation')),
  record_id uuid NOT NULL,
  request_id text,
  before_values jsonb,
  after_values jsonb NOT NULL
);
CREATE INDEX audit_entry_organisation_idx ON trucker.audit_entry (organisation_id, occurred_at);

-- ---------------------------------------------------------------------------------------------
-- Safe retries. A key stores which record it produced, never a copy of an answer, so a
-- retry is answered from the record itself, through the same access checks as any read.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.retry_key (
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9._-]{16,128}$'),
  operation text NOT NULL CHECK (operation IN ('organisation.create')),
  request_hash text NOT NULL,
  record_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (person_id, key)
);

-- ---------------------------------------------------------------------------------------------
-- Who is asking. Set per transaction by the API with set_config(..., true):
--   trucker.session_token_hash  hash of the bearer token
--   trucker.organisation_id     the organisation the request is about, if any
--   trucker.request_id          for the audit history
-- These functions run as their owner so that they can read sessions and memberships whatever
-- the caller may see, and they return only identifiers.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.request_person() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker AS $$
  SELECT s.person_id
  FROM trucker.session s
  WHERE s.token_hash = nullif(current_setting('trucker.session_token_hash', true), '')
    AND s.revoked_at IS NULL
    AND s.absolute_expires_at > now()
$$;

CREATE FUNCTION trucker.is_member(organisation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker AS $$
  SELECT EXISTS (
    SELECT 1 FROM trucker.membership m
    WHERE m.organisation_id = organisation
      AND m.person_id = trucker.request_person()
      AND m.ended_at IS NULL)
$$;

CREATE FUNCTION trucker.is_admin(organisation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker AS $$
  SELECT EXISTS (
    SELECT 1 FROM trucker.membership m
    WHERE m.organisation_id = organisation
      AND m.person_id = trucker.request_person()
      AND m.role = 'admin'
      AND m.ended_at IS NULL)
$$;

-- The organisation the request is about: the one named, and only if the person is a member.
CREATE FUNCTION trucker.request_organisation() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker AS $$
DECLARE
  named text := nullif(current_setting('trucker.organisation_id', true), '');
  candidate uuid;
BEGIN
  IF named IS NULL OR named !~ '^[0-9a-fA-F-]{36}$' THEN
    RETURN NULL;
  END IF;
  candidate := named::uuid;
  IF trucker.is_member(candidate) THEN
    RETURN candidate;
  END IF;
  RETURN NULL;
END
$$;

-- Whether the request names an organisation at all, member or not.
CREATE FUNCTION trucker.organisation_selected() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('trucker.organisation_id', true), '') IS NOT NULL
$$;

-- The organisation chooser: the one place where a person sees more than one organisation.
-- It answers only a request that has NOT selected an organisation, and returns only what a
-- chooser needs to tell them apart. Everything else about an organisation is read after
-- selecting it, under the policies below.
CREATE FUNCTION trucker.my_organisations()
RETURNS TABLE (id uuid, status text, legal_name text, registration_number text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker AS $$
BEGIN
  IF trucker.organisation_selected() THEN
    RAISE EXCEPTION 'the organisation list is not available to a request that has selected an organisation'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT o.id, o.status, o.legal_name, o.registration_number, o.created_at
    FROM trucker.organisation o
    JOIN trucker.membership m ON m.organisation_id = o.id
    WHERE m.person_id = trucker.request_person() AND m.ended_at IS NULL
    ORDER BY o.created_at DESC, o.id;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Row security. It binds the API's role, which owns nothing. The table owner (the migration
-- role) is not bound: the functions above run as the owner and must see every row to decide
-- who is a member. The API never connects as the owner; it checks this when it starts.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.organisation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.audit_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.retry_key ENABLE ROW LEVEL SECURITY;

-- A request is about one organisation at most. Rows of that organisation are visible, and of
-- no other, even one the same person also belongs to: selecting A never shows B. With no
-- organisation selected, nothing is visible here; the chooser has its own path below.
-- The selected organisation may be changed by its administrator while it is a draft.
CREATE POLICY organisation_read ON trucker.organisation FOR SELECT TO trucker_app
  USING (id = trucker.request_organisation());
CREATE POLICY organisation_change ON trucker.organisation FOR UPDATE TO trucker_app
  USING (id = trucker.request_organisation() AND trucker.is_admin(id) AND status = 'draft')
  WITH CHECK (id = trucker.request_organisation() AND trucker.is_admin(id) AND status = 'draft');

-- A person sees their own membership of the selected organisation, and no other.
CREATE POLICY membership_read ON trucker.membership FOR SELECT TO trucker_app
  USING (person_id = trucker.request_person()
         AND organisation_id = trucker.request_organisation());

-- History is read by an administrator of the organisation the request is about.
CREATE POLICY audit_read ON trucker.audit_entry FOR SELECT TO trucker_app
  USING (organisation_id = trucker.request_organisation() AND trucker.is_admin(organisation_id));

-- Retry keys belong to the person who used them, and are reachable only by a request that is
-- not about any organisation (creating one is such a request). A key points at a record, so a
-- request about organisation A must not be able to read keys that point at organisation B.
CREATE POLICY retry_key_own ON trucker.retry_key FOR ALL TO trucker_app
  USING (person_id = trucker.request_person() AND NOT trucker.organisation_selected())
  WITH CHECK (person_id = trucker.request_person() AND NOT trucker.organisation_selected());

GRANT SELECT ON trucker.organisation, trucker.membership, trucker.audit_entry TO trucker_app;
-- Only the editable columns, and the two the API maintains with them.
GRANT UPDATE (legal_name, trading_name, country_code, registration_number, address, contact_name,
              version, updated_at)
  ON trucker.organisation TO trucker_app;
GRANT SELECT, INSERT, DELETE ON trucker.retry_key TO trucker_app;

-- ---------------------------------------------------------------------------------------------
-- Every change to an organisation writes its audit entry in the same transaction. Done by a
-- trigger, so no code path can change an organisation without one, and the API cannot write,
-- alter or remove an entry itself.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.organisation_values(o trucker.organisation) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'status', o.status,
    'requestedCapability', o.requested_capability,
    'legalName', o.legal_name,
    'tradingName', o.trading_name,
    'countryCode', o.country_code,
    'registrationNumber', o.registration_number,
    'address', o.address,
    'contactName', o.contact_name,
    'version', o.version)
$$;

CREATE FUNCTION trucker.audit_organisation_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker AS $$
DECLARE
  actor uuid := trucker.request_person();
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'an organisation cannot be changed without a signed-in person'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'each change must raise the version by one' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES
    (NEW.updated_at, actor, NEW.id, 'organisation.updated', 'organisation', NEW.id,
     nullif(current_setting('trucker.request_id', true), ''),
     trucker.organisation_values(OLD), trucker.organisation_values(NEW));
  RETURN NEW;
END
$$;
CREATE TRIGGER organisation_audit AFTER UPDATE ON trucker.organisation
  FOR EACH ROW EXECUTE FUNCTION trucker.audit_organisation_change();

-- ---------------------------------------------------------------------------------------------
-- Creating an organisation: the organisation, its first administrator and the audit entry are
-- written together or not at all. The API has no INSERT right on these tables; this function
-- is the only way in, and it decides for itself who is asking.
--   creation_limit  how many organisations one person may create (a reviewed setting)
--   allow_fixtures  whether fixture countries count as enabled (local development and test)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.create_organisation(
  p_legal_name text, p_trading_name text, p_country_code text, p_registration_number text,
  p_address text, p_contact_name text, p_now timestamptz, p_creation_limit integer,
  p_allow_fixtures boolean
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker AS $$
DECLARE
  actor uuid := trucker.request_person();
  created uuid;
  new_row trucker.organisation;
  kind text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'no signed-in person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trucker.person
                 WHERE id = actor AND registration_completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'registration is not complete' USING ERRCODE = 'TR001';
  END IF;
  -- One creation at a time per person, so the limit cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('organisation.create:' || actor::text, 0));
  IF p_creation_limit IS NULL OR p_creation_limit < 1
     OR (SELECT count(*) FROM trucker.organisation WHERE created_by = actor) >= p_creation_limit THEN
    RAISE EXCEPTION 'creation limit reached' USING ERRCODE = 'TR002';
  END IF;
  SELECT e.kind INTO kind FROM trucker.environment e;
  IF NOT EXISTS (
    SELECT 1 FROM trucker.country c
    WHERE c.code = p_country_code
      AND c.registration_state = 'enabled'
      AND (NOT c.fixture
           OR (coalesce(p_allow_fixtures, false) AND kind IN ('local-development', 'test')))) THEN
    RAISE EXCEPTION 'country is not open for registration' USING ERRCODE = 'TR003';
  END IF;

  INSERT INTO trucker.organisation
    (legal_name, trading_name, country_code, registration_number, address, contact_name,
     created_by, created_at, updated_at)
  VALUES
    (p_legal_name, p_trading_name, p_country_code, p_registration_number, p_address,
     p_contact_name, actor, p_now, p_now)
  RETURNING * INTO new_row;
  created := new_row.id;
  INSERT INTO trucker.membership (organisation_id, person_id, role, created_at)
  VALUES (created, actor, 'admin', p_now);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES
    (p_now, actor, created, 'organisation.created', 'organisation', created,
     nullif(current_setting('trucker.request_id', true), ''),
     NULL, trucker.organisation_values(new_row));
  RETURN created;
END
$$;

REVOKE ALL ON FUNCTION trucker.create_organisation(text, text, text, text, text, text, timestamptz, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.create_organisation(text, text, text, text, text, text, timestamptz, integer, boolean) TO trucker_app;
REVOKE ALL ON FUNCTION trucker.request_person(), trucker.request_organisation(),
  trucker.is_member(uuid), trucker.is_admin(uuid), trucker.organisation_selected(),
  trucker.my_organisations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.request_person(), trucker.request_organisation(),
  trucker.is_member(uuid), trucker.is_admin(uuid), trucker.organisation_selected(),
  trucker.my_organisations() TO trucker_app;
