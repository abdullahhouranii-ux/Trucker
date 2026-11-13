-- 0002_identity
-- People, sign-in by a one-time code sent to a mobile number, sessions, and the record of
-- which terms a person saw at registration.
--
-- Decisions recorded on 13 November 2026 (docs/delivery/REGISTRATION_SLICE_4.md):
--   * the identifier is an international mobile number; e-mail is optional contact detail only;
--   * only demonstration terms exist. A row here is never evidence that approved legal terms
--     were accepted; the terms_kind check allows nothing else until approved terms are added
--     by a later migration.
-- No one-time code and no session token is stored: only keyed or plain hashes of them.

CREATE TABLE trucker.person (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  display_name text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 120),
  contact_email text CHECK (contact_email IS NULL OR length(contact_email) BETWEEN 3 AND 254),
  registration_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_completed_has_name
    CHECK (registration_completed_at IS NULL OR display_name IS NOT NULL)
);

COMMENT ON COLUMN trucker.person.phone_e164 IS
  'Verified mobile number in E.164 form. The country of the number grants no eligibility.';
COMMENT ON COLUMN trucker.person.contact_email IS
  'Optional and unverified. Not a sign-in identifier and not a recovery route.';

CREATE TABLE trucker.session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text
    CHECK (revoked_reason IN ('signed_out', 'revoked_by_person', 'idle_expired', 'absolute_expired')),
  CONSTRAINT session_revocation_complete
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX session_person_idx ON trucker.session (person_id);

CREATE TABLE trucker.sign_in_challenge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  code_hash text NOT NULL,
  request_key text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  superseded_at timestamptz,
  consumed_at timestamptz,
  verify_key text,
  session_id uuid REFERENCES trucker.session (id),
  CONSTRAINT sign_in_challenge_request_once UNIQUE (phone_e164, request_key),
  CONSTRAINT sign_in_challenge_consumed_complete
    CHECK ((consumed_at IS NULL) = (session_id IS NULL) AND (consumed_at IS NULL) = (verify_key IS NULL))
);

CREATE INDEX sign_in_challenge_phone_idx ON trucker.sign_in_challenge (phone_e164, created_at);

COMMENT ON COLUMN trucker.sign_in_challenge.request_key IS
  'Retry key of the request that created the challenge: a repeated request returns this row.';
COMMENT ON COLUMN trucker.sign_in_challenge.verify_key IS
  'Retry key of the request that used the code: only that request may be repeated.';

CREATE TABLE trucker.terms_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  terms_kind text NOT NULL CHECK (terms_kind IN ('demonstration')),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  language text NOT NULL CHECK (language IN ('en', 'ar', 'ur')),
  accepted_at timestamptz NOT NULL,
  CONSTRAINT terms_acceptance_once UNIQUE (person_id, terms_kind, version)
);

COMMENT ON TABLE trucker.terms_acceptance IS
  'Which terms text a person was shown and in which language. Kind "demonstration" is placeholder text for development and test and is not acceptance of legal terms.';

CREATE TABLE trucker.identity_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'signed_in', 'code_locked', 'registration_completed', 'signed_out', 'session_revoked', 'session_expired'
  )),
  person_id uuid REFERENCES trucker.person (id),
  session_id uuid REFERENCES trucker.session (id),
  request_id text
);

COMMENT ON TABLE trucker.identity_event IS
  'Append-only record of sign-in and session events. Holds no code, token or phone number.';
