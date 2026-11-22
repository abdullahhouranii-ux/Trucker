-- 0019_shipment_roles
-- Shipment roles and authority (slice 22, docs/delivery/SHIPMENT_ROLES_SLICE_22_SCOPE.md;
-- model: docs/specs/ADR_001_COMMERCIAL_MODEL.md). Approved on 17 November 2026 with S22-1 to
-- S22-3 as recommended.
--
-- Every shipment records its roles: organiser, sender, receiver, contracting customer, freight
-- payer and Trucker-fee payer. An organiser (coordinator or broker) arranges a shipment for a
-- customer that has given it authority.
--
-- Where the record lives. A shipment an organiser arranges is kept in the organiser's own
-- account, with the customer named on it as the contracting customer. That gives, with no rule
-- relaxed: each organiser reaches only the shipments it arranged, two organisers of one
-- customer see nothing of each other, and nothing else of the customer's account is reachable.
-- The customer sees every shipment arranged in its name, reads its quotations, and alone
-- accepts one: the booking's shipper is the contracting customer, never the organiser.
--
--   S22-1  the contracting customer and the fee payer are verified accounts; the sender and the
--          receiver may be named parties; the freight payer is the customer, sender or receiver;
--   S22-2  an organiser never accepts a quotation for the customer;
--   S22-3  the fee payer is the contracting customer or the organiser, and each must have agreed:
--          the organiser by naming itself, the customer in the authority it gave.
--
-- A shipment an account makes for itself keeps working as before: it is its own customer, sender
-- and payer, and its own organiser when it holds the organise capability at publication.
-- Functions replaced below are their latest definitions with the changes named beside them.
-- As before: the API's role writes none of this directly, and every function establishes who
-- is asking, takes its locks, reads the database's clock and then decides.

-- ---------------------------------------------------------------------------------------------
-- The account code: how one account names another without learning anything about it
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.new_account_code() RETURNS text
LANGUAGE sql VOLATILE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT 'TR' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
$$;
ALTER TABLE trucker.organisation
  ADD COLUMN account_code text NOT NULL DEFAULT trucker.new_account_code()
    CHECK (account_code ~ '^TR[0-9A-F]{10}$');
CREATE UNIQUE INDEX organisation_account_code ON trucker.organisation (account_code);
GRANT SELECT (account_code) ON trucker.organisation TO trucker_app;

-- ---------------------------------------------------------------------------------------------
-- Authority: from a customer to one organiser
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.organiser_authority (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  organiser_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'active', 'declined', 'ended')),
  -- What the customer allowed when it accepted.
  may_publish boolean NOT NULL DEFAULT false,
  fee_payer_agreed boolean NOT NULL DEFAULT false,
  requested_by uuid NOT NULL REFERENCES trucker.person (id),
  requested_at timestamptz NOT NULL,
  decided_by uuid REFERENCES trucker.person (id),
  decided_at timestamptz,
  ended_at timestamptz,
  ended_by text CHECK (ended_by IS NULL OR ended_by IN ('customer', 'organiser')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT organiser_authority_parties CHECK (customer_organisation_id <> organiser_organisation_id),
  CONSTRAINT organiser_authority_decided CHECK ((status IN ('requested')) = (decided_at IS NULL)),
  CONSTRAINT organiser_authority_ended CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX organiser_authority_one_open
  ON trucker.organiser_authority (customer_organisation_id, organiser_organisation_id)
  WHERE status IN ('requested', 'active');
CREATE INDEX organiser_authority_organiser_idx ON trucker.organiser_authority (organiser_organisation_id);
ALTER TABLE trucker.organiser_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.organiser_authority FROM trucker_app, PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- The roles of a shipment, and their copy on a booking
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.shipment_party (
  shipment_id uuid PRIMARY KEY REFERENCES trucker.shipment_draft (id),
  -- Nothing while the shipment is its owner's own and the owner is not an organiser.
  organiser_organisation_id uuid REFERENCES trucker.organisation (id),
  authority_id uuid REFERENCES trucker.organiser_authority (id),
  customer_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  -- Sender and receiver: the customer, or a named party, or not named (the party at the address).
  sender_is_customer boolean NOT NULL DEFAULT true,
  sender_name text CHECK (sender_name IS NULL OR length(btrim(sender_name)) BETWEEN 1 AND 200),
  receiver_is_customer boolean NOT NULL DEFAULT false,
  receiver_name text CHECK (receiver_name IS NULL OR length(btrim(receiver_name)) BETWEEN 1 AND 200),
  freight_payer text NOT NULL DEFAULT 'customer' CHECK (freight_payer IN ('customer', 'sender', 'receiver')),
  fee_payer_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  -- How the fee payer agreed, recorded when the shipment is published.
  fee_agreement text CHECK (fee_agreement IS NULL OR fee_agreement IN ('own_act', 'authority')),
  fee_agreed_by uuid REFERENCES trucker.person (id),
  fee_agreed_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT shipment_party_sender CHECK (NOT (sender_is_customer AND sender_name IS NOT NULL)),
  CONSTRAINT shipment_party_receiver CHECK (NOT (receiver_is_customer AND receiver_name IS NOT NULL)),
  CONSTRAINT shipment_party_authority CHECK (authority_id IS NULL OR organiser_organisation_id IS NOT NULL)
);
CREATE INDEX shipment_party_customer_idx ON trucker.shipment_party (customer_organisation_id);
ALTER TABLE trucker.shipment_party ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.shipment_party FROM trucker_app, PUBLIC;

-- Every shipment has its roles from the moment it exists: its owner's own, until set otherwise.
CREATE FUNCTION trucker.shipment_party_default() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  INSERT INTO trucker.shipment_party (shipment_id, customer_organisation_id, fee_payer_organisation_id, updated_at)
  VALUES (NEW.id, NEW.organisation_id, NEW.organisation_id, NEW.created_at)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
CREATE TRIGGER shipment_party_default AFTER INSERT ON trucker.shipment_draft
  FOR EACH ROW EXECUTE FUNCTION trucker.shipment_party_default();
INSERT INTO trucker.shipment_party (shipment_id, customer_organisation_id, fee_payer_organisation_id, updated_at)
SELECT d.id, d.organisation_id, d.organisation_id, d.created_at FROM trucker.shipment_draft d;

CREATE FUNCTION trucker.shipment_customer(p_shipment uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT p.customer_organisation_id FROM trucker.shipment_party p WHERE p.shipment_id = p_shipment
$$;

-- The roles as shown. Names only: no contact detail of any party is held.
CREATE FUNCTION trucker.shipment_party_values(p trucker.shipment_party) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'organiser', (SELECT jsonb_build_object('id', o.id, 'legalName', o.legal_name, 'kind', o.kind)
                  FROM trucker.organisation o WHERE o.id = p.organiser_organisation_id),
    'authorityId', p.authority_id,
    'customer', (SELECT jsonb_build_object('id', o.id, 'legalName', o.legal_name, 'kind', o.kind)
                 FROM trucker.organisation o WHERE o.id = p.customer_organisation_id),
    'sender', CASE WHEN p.sender_is_customer THEN jsonb_build_object('is', 'customer')
                   WHEN p.sender_name IS NOT NULL THEN jsonb_build_object('is', 'named', 'name', p.sender_name)
                   ELSE jsonb_build_object('is', 'not_named') END,
    'receiver', CASE WHEN p.receiver_is_customer THEN jsonb_build_object('is', 'customer')
                     WHEN p.receiver_name IS NOT NULL THEN jsonb_build_object('is', 'named', 'name', p.receiver_name)
                     ELSE jsonb_build_object('is', 'not_named') END,
    'freightPayer', p.freight_payer,
    'feePayer', CASE WHEN p.fee_payer_organisation_id = p.customer_organisation_id THEN 'customer' ELSE 'organiser' END,
    'feeAgreement', p.fee_agreement, 'feeAgreedAt', p.fee_agreed_at)
$$;

-- The roles as they stood when the quotation was accepted. Written once, never changed. The
-- booking itself (0013) is not touched: its snapshot stays exactly as it was accepted.
CREATE TABLE trucker.booking_party (
  booking_id uuid PRIMARY KEY REFERENCES trucker.booking (id),
  organiser_organisation_id uuid REFERENCES trucker.organisation (id),
  authority_id uuid REFERENCES trucker.organiser_authority (id),
  customer_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  fee_payer_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  roles jsonb NOT NULL,
  recorded_at timestamptz NOT NULL
);
ALTER TABLE trucker.booking_party ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_party FROM trucker_app, PUBLIC;
CREATE FUNCTION trucker.guard_booking_party() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'the roles of a booking are never changed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER booking_party_guard BEFORE UPDATE OR DELETE ON trucker.booking_party
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_booking_party();
CREATE TRIGGER booking_party_truncate_guard BEFORE TRUNCATE ON trucker.booking_party
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_booking_party();

CREATE FUNCTION trucker.booking_party_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  p trucker.shipment_party;
BEGIN
  SELECT * INTO p FROM trucker.shipment_party x WHERE x.shipment_id = NEW.shipment_id;
  INSERT INTO trucker.booking_party
    (booking_id, organiser_organisation_id, authority_id, customer_organisation_id,
     fee_payer_organisation_id, roles, recorded_at)
  VALUES (NEW.id, p.organiser_organisation_id, p.authority_id, p.customer_organisation_id,
          p.fee_payer_organisation_id, trucker.shipment_party_values(p), NEW.accepted_at);
  RETURN NEW;
END
$$;
CREATE TRIGGER booking_party_record AFTER INSERT ON trucker.booking
  FOR EACH ROW EXECUTE FUNCTION trucker.booking_party_record();
-- Bookings made before this migration: their roles were the shipper's own.
INSERT INTO trucker.booking_party
  (booking_id, organiser_organisation_id, authority_id, customer_organisation_id,
   fee_payer_organisation_id, roles, recorded_at)
SELECT b.id, p.organiser_organisation_id, p.authority_id, p.customer_organisation_id,
       p.fee_payer_organisation_id, trucker.shipment_party_values(p), b.accepted_at
FROM trucker.booking b JOIN trucker.shipment_party p ON p.shipment_id = b.shipment_id;

-- History.
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
    'authority.requested', 'authority.decided', 'authority.ended', 'shipment.parties_set'));
ALTER TABLE trucker.audit_entry
  DROP CONSTRAINT audit_entry_record_type_check,
  ADD CONSTRAINT audit_entry_record_type_check CHECK (record_type IN (
    'organisation', 'shipment_draft', 'verification_application', 'quotation', 'vehicle',
    'driver_affiliation', 'driver_authorisation', 'fleet_document', 'booking', 'booking_substitution',
    'organiser_authority'));

-- ---------------------------------------------------------------------------------------------
-- Authority commands
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.authority_values(a trucker.organiser_authority, p_for uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', a.id, 'version', a.row_version, 'status', a.status,
    'role', CASE WHEN a.customer_organisation_id = p_for THEN 'customer' ELSE 'organiser' END,
    'mayPublish', a.may_publish, 'feePayerAgreed', a.fee_payer_agreed,
    'requestedAt', a.requested_at, 'decidedAt', a.decided_at, 'endedAt', a.ended_at, 'endedBy', a.ended_by,
    'customer', (SELECT jsonb_build_object('legalName', o.legal_name, 'kind', o.kind)
                 FROM trucker.organisation o WHERE o.id = a.customer_organisation_id),
    'organiser', (SELECT jsonb_build_object('legalName', o.legal_name, 'kind', o.kind)
                  FROM trucker.organisation o WHERE o.id = a.organiser_organisation_id))
$$;

-- The opening of every command here: an administrator of the account named by the request.
--   status: ok | unauthorized | not_found
CREATE FUNCTION trucker.authority_enter(OUT status text, OUT actor uuid, OUT org uuid)
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
  status := 'ok';
END
$$;

-- An organiser asks a customer, named by its account code, for authority. A code that names
-- no account, the organiser's own, or an account that is not verified answers the same way.
--   status: requested | exists | not_organiser | no_account | unauthorized | not_found
CREATE FUNCTION trucker.request_authority(p_code text, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  v_customer uuid;
  a trucker.organiser_authority;
  v_at timestamptz;
BEGIN
  SELECT * INTO entered FROM trucker.authority_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT trucker.capability_effective(entered.org, 'organise') THEN
    status := 'not_organiser';
    RETURN;
  END IF;
  SELECT o.id INTO v_customer FROM trucker.organisation o
  WHERE o.account_code = upper(btrim(coalesce(p_code, ''))) AND o.id <> entered.org AND o.status = 'verified';
  IF v_customer IS NULL THEN
    status := 'no_account';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  SELECT * INTO a FROM trucker.organiser_authority x
  WHERE x.customer_organisation_id = v_customer AND x.organiser_organisation_id = entered.org
    AND x.status IN ('requested', 'active');
  IF FOUND THEN
    status := 'exists';
    detail := trucker.authority_values(a, entered.org);
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.organiser_authority
      (customer_organisation_id, organiser_organisation_id, requested_by, requested_at)
    VALUES (v_customer, entered.org, entered.actor, v_at) RETURNING * INTO a;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO a FROM trucker.organiser_authority x
    WHERE x.customer_organisation_id = v_customer AND x.organiser_organisation_id = entered.org
      AND x.status IN ('requested', 'active');
    status := 'exists';
    detail := trucker.authority_values(a, entered.org);
    RETURN;
  END;
  PERFORM trucker.fleet_audit(v_at, entered.actor, NULL, entered.org, 'authority.requested', 'organiser_authority', a.id,
                              NULL, jsonb_build_object('status', 'requested'));
  PERFORM trucker.fleet_audit(v_at, entered.actor, NULL, v_customer, 'authority.requested', 'organiser_authority', a.id,
                              NULL, jsonb_build_object('status', 'requested'));
  status := 'requested';
  detail := trucker.authority_values(a, entered.org);
END
$$;

-- The customer accepts, choosing what it allows, or declines.
--   p_content: {"decision": "accept" | "decline", "mayPublish": bool, "feePayerAgreed": bool}
--   status: accepted | declined | already_decided | conflict | invalid | unauthorized | not_found
CREATE FUNCTION trucker.decide_authority(
  p_authority uuid, p_expected_version integer, p_content jsonb, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  a trucker.organiser_authority;
  v_at timestamptz;
  v_decision text := p_content ->> 'decision';
BEGIN
  SELECT * INTO entered FROM trucker.authority_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO a FROM trucker.organiser_authority x
  WHERE x.id = p_authority AND x.customer_organisation_id = entered.org FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  IF a.status <> 'requested' THEN
    status := 'already_decided';
    detail := trucker.authority_values(a, entered.org);
    RETURN;
  END IF;
  IF a.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF v_decision IS NULL OR v_decision NOT IN ('accept', 'decline')
     OR (v_decision = 'accept' AND (jsonb_typeof(p_content -> 'mayPublish') IS DISTINCT FROM 'boolean'
                                    OR jsonb_typeof(p_content -> 'feePayerAgreed') IS DISTINCT FROM 'boolean')) THEN
    status := 'invalid';
    RETURN;
  END IF;
  UPDATE trucker.organiser_authority x
  SET status = CASE WHEN v_decision = 'accept' THEN 'active' ELSE 'declined' END,
      may_publish = v_decision = 'accept' AND (p_content ->> 'mayPublish')::boolean,
      fee_payer_agreed = v_decision = 'accept' AND (p_content ->> 'feePayerAgreed')::boolean,
      decided_by = entered.actor, decided_at = v_at, row_version = x.row_version + 1
  WHERE x.id = a.id RETURNING * INTO a;
  PERFORM trucker.fleet_audit(v_at, entered.actor, NULL, o, 'authority.decided', 'organiser_authority', a.id,
                              jsonb_build_object('status', 'requested'),
                              jsonb_build_object('status', a.status, 'mayPublish', a.may_publish,
                                                 'feePayerAgreed', a.fee_payer_agreed))
  FROM unnest(ARRAY[a.customer_organisation_id, a.organiser_organisation_id]) o;
  status := CASE WHEN v_decision = 'accept' THEN 'accepted' ELSE 'declined' END;
  detail := trucker.authority_values(a, entered.org);
END
$$;

-- Either side ends it, at once. What was already done under it stays.
--   status: ended | already_ended | conflict | unauthorized | not_found
CREATE FUNCTION trucker.end_authority(p_authority uuid, p_expected_version integer, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  a trucker.organiser_authority;
  v_at timestamptz;
  v_before text;
BEGIN
  SELECT * INTO entered FROM trucker.authority_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO a FROM trucker.organiser_authority x
  WHERE x.id = p_authority AND entered.org IN (x.customer_organisation_id, x.organiser_organisation_id) FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  IF a.status NOT IN ('requested', 'active') THEN
    status := 'already_ended';
    detail := trucker.authority_values(a, entered.org);
    RETURN;
  END IF;
  IF a.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  v_before := a.status;
  UPDATE trucker.organiser_authority x
  SET status = 'ended', ended_at = v_at,
      ended_by = CASE WHEN x.customer_organisation_id = entered.org THEN 'customer' ELSE 'organiser' END,
      decided_by = coalesce(x.decided_by, entered.actor), decided_at = coalesce(x.decided_at, v_at),
      row_version = x.row_version + 1
  WHERE x.id = a.id RETURNING * INTO a;
  PERFORM trucker.fleet_audit(v_at, entered.actor, NULL, o, 'authority.ended', 'organiser_authority', a.id,
                              jsonb_build_object('status', v_before),
                              jsonb_build_object('status', 'ended', 'endedBy', a.ended_by))
  FROM unnest(ARRAY[a.customer_organisation_id, a.organiser_organisation_id]) o;
  status := 'ended';
  detail := trucker.authority_values(a, entered.org);
END
$$;

-- What the account named by the request sees: its code, its authorities on either side, and
-- the shipments arranged in its name by others, each with the carrier projection only.
--   status: ok | unauthorized | not_found
CREATE FUNCTION trucker.authority_overview(OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  v_at timestamptz;
BEGIN
  SELECT * INTO entered FROM trucker.authority_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  detail := jsonb_build_object(
    'accountCode', (SELECT o.account_code FROM trucker.organisation o WHERE o.id = entered.org),
    'organiser', trucker.capability_effective(entered.org, 'organise'),
    'authorities', coalesce((
      SELECT jsonb_agg(trucker.authority_values(a, entered.org) ORDER BY a.requested_at DESC, a.id)
      FROM trucker.organiser_authority a
      WHERE entered.org IN (a.customer_organisation_id, a.organiser_organisation_id)), '[]'::jsonb),
    'arranged', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', d.id, 'status', d.status, 'reference', d.shipper_reference,
               'parties', trucker.shipment_party_values(p),
               'shipment', CASE WHEN d.published_version IS NOT NULL
                                THEN trucker.shipment_carrier_values(d, v_at) END)
             ORDER BY d.created_at DESC, d.id)
      FROM trucker.shipment_party p JOIN trucker.shipment_draft d ON d.id = p.shipment_id
      WHERE p.customer_organisation_id = entered.org AND d.organisation_id <> entered.org
        AND d.status <> 'draft'), '[]'::jsonb));
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Setting the roles of a draft. Fixed once the shipment has been published.
--   p_content: {"customerAuthorityId": uuid | null,     null: the account's own shipment
--               "sender": "customer" | "not_named" | {"name": text},
--               "receiver": "customer" | "not_named" | {"name": text},
--               "freightPayer": "customer" | "sender" | "receiver",
--               "feePayer": "customer" | "organiser"}
--   status: saved | invalid | not_draft | conflict | unauthorized | not_found
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.shipment_parties(p_shipment uuid, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  p trucker.shipment_party;
BEGIN
  SELECT * INTO entered FROM trucker.shipment_enter(p_shipment);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO p FROM trucker.shipment_party x WHERE x.shipment_id = p_shipment;
  detail := jsonb_build_object(
    'parties', trucker.shipment_party_values(p),
    'editable', (entered.row_found).published_version IS NULL AND (entered.row_found).status = 'draft',
    'customers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'authorityId', a.id, 'legalName', o.legal_name, 'mayPublish', a.may_publish,
               'feePayerAgreed', a.fee_payer_agreed) ORDER BY o.legal_name, a.id)
      FROM trucker.organiser_authority a JOIN trucker.organisation o ON o.id = a.customer_organisation_id
      WHERE a.organiser_organisation_id = entered.org AND a.status = 'active'), '[]'::jsonb));
END
$$;

CREATE FUNCTION trucker.set_shipment_parties(
  p_shipment uuid, p_expected_version integer, p_content jsonb, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.shipment_draft;
  a trucker.organiser_authority;
  p trucker.shipment_party;
  problems jsonb := '[]'::jsonb;
  v_customer uuid;
  v_sender text;
  v_receiver text;
  v_sender_name text;
  v_receiver_name text;
  v_freight text := p_content ->> 'freightPayer';
  v_fee text := p_content ->> 'feePayer';
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
  v_customer := entered.org;
  IF p_content ->> 'customerAuthorityId' IS NOT NULL THEN
    SELECT * INTO a FROM trucker.organiser_authority x
    WHERE x.id::text = p_content ->> 'customerAuthorityId' AND x.organiser_organisation_id = entered.org
      AND x.status = 'active';
    IF NOT FOUND THEN
      problems := problems || jsonb_build_object('field', 'customer', 'code', 'no_authority');
    ELSE
      v_customer := a.customer_organisation_id;
    END IF;
  END IF;
  v_sender := CASE WHEN jsonb_typeof(p_content -> 'sender') = 'object' THEN 'named' ELSE p_content ->> 'sender' END;
  v_receiver := CASE WHEN jsonb_typeof(p_content -> 'receiver') = 'object' THEN 'named' ELSE p_content ->> 'receiver' END;
  v_sender_name := btrim(coalesce(p_content #>> '{sender,name}', ''));
  v_receiver_name := btrim(coalesce(p_content #>> '{receiver,name}', ''));
  IF v_sender IS NULL OR v_sender NOT IN ('customer', 'not_named', 'named')
     OR (v_sender = 'named' AND length(v_sender_name) NOT BETWEEN 1 AND 200) THEN
    problems := problems || jsonb_build_object('field', 'sender', 'code', 'required');
  END IF;
  IF v_receiver IS NULL OR v_receiver NOT IN ('customer', 'not_named', 'named')
     OR (v_receiver = 'named' AND length(v_receiver_name) NOT BETWEEN 1 AND 200) THEN
    problems := problems || jsonb_build_object('field', 'receiver', 'code', 'required');
  END IF;
  IF v_freight IS NULL OR v_freight NOT IN ('customer', 'sender', 'receiver') THEN
    problems := problems || jsonb_build_object('field', 'freightPayer', 'code', 'required');
  END IF;
  -- Only the customer or the organiser pays Trucker's fee (S22-3).
  IF v_fee IS NULL OR v_fee NOT IN ('customer', 'organiser') OR (v_fee = 'organiser' AND a.id IS NULL) THEN
    problems := problems || jsonb_build_object('field', 'feePayer', 'code', 'required');
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  UPDATE trucker.shipment_party x
  SET organiser_organisation_id = CASE WHEN a.id IS NOT NULL THEN entered.org END,
      authority_id = a.id,
      customer_organisation_id = v_customer,
      sender_is_customer = v_sender = 'customer',
      sender_name = CASE WHEN v_sender = 'named' THEN v_sender_name END,
      receiver_is_customer = v_receiver = 'customer',
      receiver_name = CASE WHEN v_receiver = 'named' THEN v_receiver_name END,
      freight_payer = v_freight,
      fee_payer_organisation_id = CASE WHEN v_fee = 'organiser' THEN entered.org ELSE v_customer END,
      fee_agreement = NULL, fee_agreed_by = NULL, fee_agreed_at = NULL,
      updated_at = entered.at
  WHERE x.shipment_id = d.id RETURNING * INTO p;
  PERFORM trucker.fleet_audit(entered.at, entered.actor, NULL, entered.org, 'shipment.parties_set', 'shipment_draft',
                              d.id, NULL, trucker.shipment_party_values(p));
  status := 'saved';
  detail := trucker.shipment_party_values(p);
END
$$;

-- What the roles add to the reasons a shipment cannot be published now. Judged at the moment
-- of each publication, change and republication, after its locks: an authority ended while
-- the command waited refuses it.
CREATE FUNCTION trucker.party_problems(d trucker.shipment_draft) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  p trucker.shipment_party;
  a trucker.organiser_authority;
  problems jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO p FROM trucker.shipment_party x WHERE x.shipment_id = d.id;
  IF p.customer_organisation_id = d.organisation_id THEN
    RETURN problems;
  END IF;
  SELECT * INTO a FROM trucker.organiser_authority x WHERE x.id = p.authority_id;
  IF NOT trucker.capability_effective(d.organisation_id, 'organise') THEN
    problems := problems || jsonb_build_object('field', 'organiser', 'code', 'not_organiser');
  END IF;
  IF a.id IS NULL OR a.status <> 'active' OR NOT a.may_publish THEN
    problems := problems || jsonb_build_object('field', 'customer', 'code', 'no_authority');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trucker.organisation o
                 WHERE o.id = p.customer_organisation_id AND o.status = 'verified') THEN
    problems := problems || jsonb_build_object('field', 'customer', 'code', 'not_verified');
  END IF;
  IF p.fee_payer_organisation_id = p.customer_organisation_id AND NOT coalesce(a.fee_payer_agreed, false) THEN
    problems := problems || jsonb_build_object('field', 'feePayer', 'code', 'not_agreed');
  END IF;
  RETURN problems;
END
$$;

-- Publication problems (replaces 0008's): the same, and the roles' problems with them.
CREATE OR REPLACE FUNCTION trucker.publication_problems(d trucker.shipment_draft, p_at timestamp with time zone, p_check_lead boolean, p_check_route boolean, p_allow_fixtures boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
DECLARE
  problems jsonb := '[]'::jsonb;
  lead integer;
  route jsonb;
  needed record;
BEGIN
  FOR needed IN
    SELECT * FROM (VALUES
      ('cargoDescription', d.cargo_description IS NOT NULL),
      ('grossWeightKg', d.gross_weight_kg IS NOT NULL),
      ('pickup.address', d.pickup_address IS NOT NULL),
      ('pickup.countryCode', d.pickup_country IS NOT NULL),
      ('pickup.timeZone', d.pickup_time_zone IS NOT NULL),
      ('pickup.from', d.pickup_from_at IS NOT NULL),
      ('pickup.until', d.pickup_until_at IS NOT NULL),
      ('delivery.address', d.delivery_address IS NOT NULL),
      ('delivery.countryCode', d.delivery_country IS NOT NULL),
      ('delivery.timeZone', d.delivery_time_zone IS NOT NULL),
      ('delivery.from', d.delivery_from_at IS NOT NULL),
      ('delivery.until', d.delivery_until_at IS NOT NULL)) v (field, present)
  LOOP
    IF NOT needed.present THEN
      problems := problems || jsonb_build_object('field', needed.field, 'code', 'required_to_publish');
    END IF;
  END LOOP;
  IF d.pickup_from_at IS NOT NULL AND d.pickup_from_at <= p_at THEN
    problems := problems || jsonb_build_object('field', 'pickup.from', 'code', 'in_past');
  END IF;
  IF d.deadline_at IS NOT NULL THEN
    IF d.deadline_at <= p_at THEN
      problems := problems || jsonb_build_object('field', 'quotationDeadline', 'code', 'in_past');
    ELSIF p_check_lead THEN
      SELECT g.publication_lead_minutes INTO lead FROM trucker.security_setting g;
      IF d.deadline_at < p_at + make_interval(mins => lead) THEN
        problems := problems || jsonb_build_object('field', 'quotationDeadline', 'code', 'too_soon', 'minutes', lead);
      END IF;
    END IF;
    IF d.pickup_from_at IS NOT NULL AND d.deadline_at >= d.pickup_from_at THEN
      problems := problems || jsonb_build_object('field', 'quotationDeadline', 'code', 'after_pickup');
    END IF;
  END IF;
  IF p_check_route AND d.pickup_country IS NOT NULL AND d.delivery_country IS NOT NULL THEN
    route := trucker.route_check(d.pickup_country, d.delivery_country, p_allow_fixtures);
    IF route ->> 'status' <> 'open' THEN
      problems := problems || jsonb_build_object('field', 'route', 'code', 'not_open', 'reasons', route -> 'reasons');
    END IF;
  END IF;
  RETURN problems || trucker.party_problems(d);
END
$$;

-- When a shipment becomes published: who organised it and how the fee payer agreed are recorded.
CREATE FUNCTION trucker.shipment_party_publish() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  p trucker.shipment_party;
  a trucker.organiser_authority;
BEGIN
  IF NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    SELECT * INTO p FROM trucker.shipment_party x WHERE x.shipment_id = NEW.id;
    SELECT * INTO a FROM trucker.organiser_authority x WHERE x.id = p.authority_id;
    UPDATE trucker.shipment_party x
    SET organiser_organisation_id = CASE
          WHEN x.customer_organisation_id <> NEW.organisation_id THEN NEW.organisation_id
          WHEN trucker.capability_effective(NEW.organisation_id, 'organise') THEN NEW.organisation_id
          ELSE x.organiser_organisation_id END,
        fee_agreement = CASE WHEN x.fee_payer_organisation_id = NEW.organisation_id THEN 'own_act' ELSE 'authority' END,
        fee_agreed_by = CASE WHEN x.fee_payer_organisation_id = NEW.organisation_id
                             THEN trucker.request_person() ELSE a.decided_by END,
        fee_agreed_at = CASE WHEN x.fee_payer_organisation_id = NEW.organisation_id
                             THEN NEW.updated_at ELSE a.decided_at END,
        updated_at = NEW.updated_at
    WHERE x.shipment_id = NEW.id AND x.fee_agreement IS NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER shipment_party_publish AFTER UPDATE OF status ON trucker.shipment_draft
  FOR EACH ROW EXECUTE FUNCTION trucker.shipment_party_publish();

-- ---------------------------------------------------------------------------------------------
-- Acceptance (replaces 0017's): only the contracting customer accepts, and the booking's shipper
-- is the contracting customer. For a shipment an account made for itself nothing changes.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.accept_quotation(p_quotation uuid, p_expected_version integer, p_key text, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $$
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
  hash text := trucker.content_hash(jsonb_build_object('q', p_quotation, 'v', p_expected_version));
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
      detail := trucker.booking_values(b);
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
     positioning_minutes, completion_minutes, planned_start_at, planned_end_at, accepted_by, accepted_at)
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
     t.positioning_minutes, t.completion_minutes, t.planned_start_at, t.planned_end_at, actor, v_at)
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
  detail := trucker.booking_values(b);
END
$$;

-- The shipper's view of a shipment's booking and of what accepting would fix (replaces 0017's):
-- readable by the account that keeps the shipment and by the contracting customer; the booking
-- and the acceptance choices are the customer's alone.
CREATE OR REPLACE FUNCTION trucker.booking_overview(p_shipment uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
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
  b trucker.booking;
  v_at timestamptz;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment AND v_org IN (x.organisation_id, trucker.shipment_customer(x.id)) FOR SHARE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  PERFORM trucker.quotation_expire_shipment(d.id, v_at);
  SELECT * INTO b FROM trucker.booking x WHERE x.shipment_id = d.id AND EXISTS (SELECT 1 FROM trucker.booking_publication_cycle z WHERE z.booking_id=x.id AND z.cycle_id=d.publication_cycle);
  status := 'ok';
  detail := jsonb_build_object(
    'open', trucker.booking_terms_available(p_allow_fixtures),
    'booking', CASE WHEN b.id IS NOT NULL AND trucker.shipment_customer(d.id) = v_org THEN trucker.booking_view(b, 'shipper', v_at) END,
    'acceptance', coalesce((
      SELECT jsonb_agg(trucker.acceptance_preview(q, d, v_at, p_allow_fixtures) ORDER BY q.created_at, q.id)
      FROM trucker.quotation q WHERE q.shipment_id = d.id AND q.status = 'submitted'
        AND trucker.shipment_customer(d.id) = v_org), '[]'::jsonb));
END
$$;

-- The quotations of a shipment (replaces 0018's): also readable by the contracting customer.
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
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment AND v_org IN (x.organisation_id, trucker.shipment_customer(x.id)) FOR SHARE;
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

-- ---------------------------------------------------------------------------------------------
-- Who may run what.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.request_authority(text),
  trucker.decide_authority(uuid, integer, jsonb),
  trucker.end_authority(uuid, integer),
  trucker.authority_overview(),
  trucker.shipment_parties(uuid),
  trucker.set_shipment_parties(uuid, integer, jsonb)
TO trucker_app;
