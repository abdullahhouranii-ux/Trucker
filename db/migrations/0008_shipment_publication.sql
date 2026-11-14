-- Shipment publication (slice 10). Approved by Abdullah on 15 November 2026 with PB-1 to PB-5.
--
-- A shipper organisation that may publish (slice 9: verified, holding `ship`, and never in a
-- production database on demonstration evidence) turns a complete draft into a published
-- shipment with a quotation deadline. It can change it (a change to what carriers would see,
-- to the deadline or to the dangerous-goods answer is a new numbered version), withdraw it,
-- and see it expire. Staff read published shipments. No carrier can read anything yet (PB-1):
-- what carriers would see is a named projection, shown to the shipper as a preview only.
--
-- Expiry needs no worker. A published shipment whose deadline has passed is expired at every
-- read, because state is judged against the database clock. The first read or change after
-- the deadline records it, once, under the shipment's row lock, dated at the deadline.
--
-- Suspension (PB-5) is a record per cause (verification, route), opened and ended once each,
-- each transition audited once. A suspended shipment stays published but would be hidden from
-- discovery and closed to quotations; nothing is cancelled. It is no longer suspended only when
-- every cause has ended, each by its own recheck. Expiry is decided before any suspension.
--
-- Locks are taken in one order everywhere: the organisation, then its shipments. The staff
-- functions of slice 9 lock the organisation first as well, so a publication cannot slip past a
-- verification that is being withdrawn.
--
-- Cargo categories and equipment types are fictional catalogues (PB-2). The tables refuse rows
-- in any database not marked local-development or test, so production registers stay empty and
-- nothing is publishable there until D-006 is decided.

-- ---------------------------------------------------------------------------------------------
-- Catalogues. Fictional only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.cargo_category (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_en text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  name_ar text NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_ur text NOT NULL CHECK (length(name_ur) BETWEEN 1 AND 120),
  -- An excluded category is known, and refused for publication.
  excluded boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 1,
  fixture boolean NOT NULL DEFAULT true CHECK (fixture)
);
CREATE TABLE trucker.equipment_type (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_en text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  name_ar text NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_ur text NOT NULL CHECK (length(name_ur) BETWEEN 1 AND 120),
  position integer NOT NULL DEFAULT 1,
  fixture boolean NOT NULL DEFAULT true CHECK (fixture)
);
COMMENT ON TABLE trucker.cargo_category IS
  'Fictional cargo categories for development and tests. No real catalogue is approved (D-006).';
COMMENT ON TABLE trucker.equipment_type IS
  'Fictional equipment types for development and tests. No real catalogue is approved (D-006).';

CREATE FUNCTION trucker.guard_catalogue() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF (SELECT e.kind FROM trucker.environment e) NOT IN ('local-development', 'test') THEN
    RAISE EXCEPTION 'catalogue entries are fictional and allowed only in a database marked local-development or test'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cargo_category_guard BEFORE INSERT OR UPDATE ON trucker.cargo_category
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_catalogue();
CREATE TRIGGER equipment_type_guard BEFORE INSERT OR UPDATE ON trucker.equipment_type
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_catalogue();
GRANT SELECT ON trucker.cargo_category, trucker.equipment_type TO trucker_app;

-- A database holding catalogue entries cannot then be marked for anything else.
CREATE FUNCTION trucker.guard_environment_catalogue() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF NEW.kind NOT IN ('local-development', 'test')
     AND (EXISTS (SELECT 1 FROM trucker.cargo_category) OR EXISTS (SELECT 1 FROM trucker.equipment_type)) THEN
    RAISE EXCEPTION 'this database holds fictional catalogue entries and cannot be marked %', NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER environment_guard_catalogue BEFORE UPDATE ON trucker.environment
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_environment_catalogue();

-- ---------------------------------------------------------------------------------------------
-- Protected settings. Development defaults; both need review before production.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.security_setting
  ADD COLUMN publication_lead_minutes integer NOT NULL DEFAULT 120
    CHECK (publication_lead_minutes BETWEEN 1 AND 10080),
  ADD COLUMN published_shipment_limit integer NOT NULL DEFAULT 50
    CHECK (published_shipment_limit BETWEEN 1 AND 10000);
UPDATE trucker.security_setting SET reviewed_for_production = false;

-- ---------------------------------------------------------------------------------------------
-- The shipment record grows the publication details and its life after the draft. The table
-- keeps its name: a published shipment is the same record as the draft it came from.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.shipment_draft
  DROP CONSTRAINT shipment_draft_status_check,
  ADD CONSTRAINT shipment_draft_status_check
    CHECK (status IN ('draft', 'discarded', 'published', 'withdrawn', 'expired')),
  ADD COLUMN cargo_category text REFERENCES trucker.cargo_category (code),
  ADD COLUMN equipment_type text REFERENCES trucker.equipment_type (code),
  -- The answer to "dangerous goods?": required to publish; "yes" is refused (PB-2).
  ADD COLUMN dangerous_goods boolean,
  -- A town or area for each place: what carriers would see instead of the address (PB-4).
  ADD COLUMN pickup_area text CHECK (pickup_area IS NULL OR length(btrim(pickup_area)) BETWEEN 1 AND 120),
  ADD COLUMN delivery_area text CHECK (delivery_area IS NULL OR length(btrim(delivery_area)) BETWEEN 1 AND 120),
  -- The quotation deadline, typed as the time on the clock at the pick-up place.
  ADD COLUMN deadline_local timestamp,
  ADD COLUMN deadline_offset_minutes integer,
  ADD COLUMN deadline_at timestamptz,
  -- The published version: 1 at publication, one more for each material change or republication.
  ADD COLUMN published_version integer CHECK (published_version IS NULL OR published_version >= 1),
  ADD COLUMN published_at timestamptz,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN expired_at timestamptz,
  ADD COLUMN copied_from uuid REFERENCES trucker.shipment_draft (id),
  ADD CONSTRAINT shipment_draft_deadline_resolved CHECK (
    (deadline_at IS NULL AND deadline_offset_minutes IS NULL)
    OR (deadline_at IS NOT NULL AND deadline_offset_minutes IS NOT NULL AND deadline_local IS NOT NULL)),
  -- Once published, the record always carries everything publication required.
  ADD CONSTRAINT shipment_draft_publication_complete CHECK (
    status IN ('draft', 'discarded')
    OR (published_version IS NOT NULL AND published_at IS NOT NULL AND deadline_at IS NOT NULL
        AND cargo_category IS NOT NULL AND equipment_type IS NOT NULL AND dangerous_goods IS FALSE
        AND pickup_area IS NOT NULL AND delivery_area IS NOT NULL)),
  ADD CONSTRAINT shipment_draft_withdrawn CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  ADD CONSTRAINT shipment_draft_expired CHECK ((status = 'expired') = (expired_at IS NOT NULL));
COMMENT ON TABLE trucker.shipment_draft IS
  'A shipment: a private draft, then possibly published. No carrier can read it in this slice.';

-- Each published version, as carriers would see it. Never changed after it is written.
CREATE TABLE trucker.shipment_publication_version (
  shipment_id uuid NOT NULL REFERENCES trucker.shipment_draft (id),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  version_no integer NOT NULL CHECK (version_no >= 1),
  kind text NOT NULL CHECK (kind IN ('published', 'changed', 'republished')),
  carrier_values jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES trucker.person (id),
  PRIMARY KEY (shipment_id, version_no)
);

-- Suspensions, one per cause. At most one open per shipment and cause.
CREATE TABLE trucker.shipment_suspension (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES trucker.shipment_draft (id),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  cause text NOT NULL CHECK (cause IN ('verification', 'route')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  -- recheck: the cause's condition passed again. expiry, withdrawal: the shipment ended first.
  ended_by text CHECK (ended_by IN ('recheck', 'expiry', 'withdrawal')),
  CONSTRAINT shipment_suspension_end CHECK ((ended_at IS NULL) = (ended_by IS NULL)
                                            AND (ended_at IS NULL OR ended_at >= started_at))
);
CREATE UNIQUE INDEX shipment_suspension_open ON trucker.shipment_suspension (shipment_id, cause)
  WHERE ended_at IS NULL;

ALTER TABLE trucker.shipment_publication_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY shipment_publication_version_read ON trucker.shipment_publication_version FOR SELECT
  TO trucker_app USING (organisation_id = trucker.request_organisation());
GRANT SELECT ON trucker.shipment_publication_version TO trucker_app;
ALTER TABLE trucker.shipment_suspension ENABLE ROW LEVEL SECURITY;
CREATE POLICY shipment_suspension_read ON trucker.shipment_suspension FOR SELECT
  TO trucker_app USING (organisation_id = trucker.request_organisation());
GRANT SELECT ON trucker.shipment_suspension TO trucker_app;

ALTER TABLE trucker.shipment_retry_key
  DROP CONSTRAINT shipment_retry_key_operation_check,
  ADD CONSTRAINT shipment_retry_key_operation_check CHECK (operation IN (
    'create', 'update', 'discard', 'publish', 'change', 'withdraw', 'republish', 'copy'));

-- History. Expiry and suspension are done by nobody: their entries carry no actor.
ALTER TABLE trucker.audit_entry
  DROP CONSTRAINT audit_entry_one_actor,
  ADD CONSTRAINT audit_entry_one_actor CHECK (
    (actor_person_id IS NULL) <> (actor_staff_id IS NULL)
    OR (actor_person_id IS NULL AND actor_staff_id IS NULL
        AND action IN ('shipment.expired', 'shipment.suspended', 'shipment.suspension_ended'))),
  DROP CONSTRAINT audit_entry_action_check,
  ADD CONSTRAINT audit_entry_action_check CHECK (action IN (
    'organisation.created', 'organisation.updated',
    'shipment.created', 'shipment.updated', 'shipment.discarded',
    'shipment.published', 'shipment.version_created', 'shipment.withdrawn', 'shipment.expired',
    'shipment.republished', 'shipment.copied', 'shipment.suspended', 'shipment.suspension_ended',
    'verification.submitted', 'verification.withdrawn', 'verification.claim_raised',
    'verification.decided', 'verification.revoked'));
-- One expiry per shipment, whatever happens: the database itself holds the "exactly once".
CREATE UNIQUE INDEX audit_entry_one_expiry ON trucker.audit_entry (record_id)
  WHERE action = 'shipment.expired';

-- ---------------------------------------------------------------------------------------------
-- Building blocks. None is callable by the API's role.
-- ---------------------------------------------------------------------------------------------

-- Whether an organisation may publish: slice 9's rule, for a named organisation.
CREATE FUNCTION trucker.organisation_publishable(p_organisation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM trucker.organisation o
    JOIN trucker.organisation_capability c ON c.organisation_id = o.id
    WHERE o.id = p_organisation
      AND o.status = 'verified'
      AND c.capability = 'ship' AND c.status = 'granted'
      AND NOT (c.basis = 'demonstration' AND (SELECT e.kind FROM trucker.environment e) = 'production'))
$$;

-- Whether a catalogue entry may be used by this request: fictional entries need fixtures to
-- have been asked for and a database marked for them. There are no other entries.
CREATE FUNCTION trucker.catalogue_available(p_allow_fixtures boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(p_allow_fixtures, false)
     AND (SELECT e.kind FROM trucker.environment e) IN ('local-development', 'test')
$$;

-- What carriers would see of a shipment, and what makes a change material (PB-3, PB-4):
-- the lane's two countries, a town or area per place, the windows in local time, the cargo
-- category, description, weight, pieces and packaging, the equipment type and notes, the
-- dangerous-goods answer and the quotation deadline. Never an address, access notes, the
-- shipper's reference, the organisation or anyone's contact. The free-text fields are shown as
-- typed: the shipper is told they may reveal who they are (see the preview).
CREATE FUNCTION trucker.shipment_material_values(d trucker.shipment_draft) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'pickup', jsonb_build_object(
      'countryCode', d.pickup_country, 'area', d.pickup_area, 'timeZone', d.pickup_time_zone,
      'from', jsonb_build_object('local', to_char(d.pickup_from_local, 'YYYY-MM-DD"T"HH24:MI'),
                                 'offsetMinutes', d.pickup_from_offset_minutes, 'at', d.pickup_from_at),
      'until', jsonb_build_object('local', to_char(d.pickup_until_local, 'YYYY-MM-DD"T"HH24:MI'),
                                  'offsetMinutes', d.pickup_until_offset_minutes, 'at', d.pickup_until_at)),
    'delivery', jsonb_build_object(
      'countryCode', d.delivery_country, 'area', d.delivery_area, 'timeZone', d.delivery_time_zone,
      'from', jsonb_build_object('local', to_char(d.delivery_from_local, 'YYYY-MM-DD"T"HH24:MI'),
                                 'offsetMinutes', d.delivery_from_offset_minutes, 'at', d.delivery_from_at),
      'until', jsonb_build_object('local', to_char(d.delivery_until_local, 'YYYY-MM-DD"T"HH24:MI'),
                                  'offsetMinutes', d.delivery_until_offset_minutes, 'at', d.delivery_until_at)),
    'cargo', jsonb_build_object(
      'category', d.cargo_category, 'description', d.cargo_description,
      'grossWeightKg', trim_scale(d.gross_weight_kg)::text, 'pieces', d.pieces, 'packaging', d.packaging),
    'equipment', jsonb_build_object('type', d.equipment_type, 'notes', d.equipment_needed),
    'dangerousGoods', d.dangerous_goods,
    'quotationDeadline', jsonb_build_object(
      'local', to_char(d.deadline_local, 'YYYY-MM-DD"T"HH24:MI'),
      'offsetMinutes', d.deadline_offset_minutes, 'at', d.deadline_at, 'timeZone', d.pickup_time_zone))
$$;

-- The state a shipment is in at a moment: a published shipment past its deadline is expired
-- whether or not that has been recorded yet; one with an open suspension is suspended.
CREATE FUNCTION trucker.shipment_state(d trucker.shipment_draft, p_at timestamptz) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE
    WHEN d.status = 'published' AND d.deadline_at <= p_at THEN 'expired'
    WHEN d.status = 'published' AND EXISTS (
           SELECT 1 FROM trucker.shipment_suspension s WHERE s.shipment_id = d.id AND s.ended_at IS NULL)
      THEN 'suspended'
    ELSE d.status END
$$;

-- The projection itself: the material values, the lane's transit countries as configured now,
-- the published version and state, and the shipper as "verified shipper", never by name.
CREATE FUNCTION trucker.shipment_carrier_values(d trucker.shipment_draft, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT trucker.shipment_material_values(d) || jsonb_build_object(
    'lane', jsonb_build_object(
      'origin', d.pickup_country, 'destination', d.delivery_country,
      'transit', coalesce((SELECT jsonb_agg(t.country_code ORDER BY t.position)
                           FROM trucker.lane l JOIN trucker.lane_transit t ON t.lane_id = l.id
                           WHERE l.origin_country = d.pickup_country
                             AND l.destination_country = d.delivery_country), '[]'::jsonb)),
    'shipper', 'verified_shipper',
    'publishedVersion', d.published_version,
    'state', trucker.shipment_state(d, p_at))
$$;

-- The publication details, as given: {"cargoCategory", "equipmentType", "dangerousGoods",
-- "pickupArea", "deliveryArea", "quotationDeadline": {"local", "offsetMinutes"}}.
CREATE FUNCTION trucker.resolve_publication_details(
  p_details jsonb, p_pickup_zone text, p_allow_fixtures boolean,
  OUT cargo_category text, OUT equipment_type text, OUT dangerous_goods boolean,
  OUT pickup_area text, OUT delivery_area text,
  OUT deadline_local timestamp, OUT deadline_offset_minutes integer, OUT deadline_at timestamptz,
  OUT problems jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  given text;
  found_category trucker.cargo_category;
  deadline record;
  area text;
  place text;
BEGIN
  problems := '[]'::jsonb;
  IF p_details IS NULL OR jsonb_typeof(p_details) <> 'object' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  given := nullif(p_details ->> 'cargoCategory', '');
  IF given IS NULL THEN
    problems := problems || jsonb_build_object('field', 'cargoCategory', 'code', 'required');
  ELSE
    SELECT * INTO found_category FROM trucker.cargo_category c WHERE c.code = given;
    IF NOT FOUND OR NOT trucker.catalogue_available(p_allow_fixtures) THEN
      problems := problems || jsonb_build_object('field', 'cargoCategory', 'code', 'unknown');
    ELSIF found_category.excluded THEN
      problems := problems || jsonb_build_object('field', 'cargoCategory', 'code', 'not_accepted');
    ELSE
      cargo_category := given;
    END IF;
  END IF;
  given := nullif(p_details ->> 'equipmentType', '');
  IF given IS NULL THEN
    problems := problems || jsonb_build_object('field', 'equipmentType', 'code', 'required');
  ELSIF NOT EXISTS (SELECT 1 FROM trucker.equipment_type e WHERE e.code = given)
        OR NOT trucker.catalogue_available(p_allow_fixtures) THEN
    problems := problems || jsonb_build_object('field', 'equipmentType', 'code', 'unknown');
  ELSE
    equipment_type := given;
  END IF;
  IF jsonb_typeof(p_details -> 'dangerousGoods') <> 'boolean' OR p_details -> 'dangerousGoods' IS NULL THEN
    problems := problems || jsonb_build_object('field', 'dangerousGoods', 'code', 'required');
  ELSE
    dangerous_goods := (p_details ->> 'dangerousGoods')::boolean;
    IF dangerous_goods THEN
      problems := problems || jsonb_build_object('field', 'dangerousGoods', 'code', 'not_accepted');
    END IF;
  END IF;
  FOREACH place IN ARRAY ARRAY['pickup', 'delivery'] LOOP
    area := nullif(btrim(coalesce(p_details ->> (place || 'Area'), '')), '');
    IF area IS NULL THEN
      problems := problems || jsonb_build_object('field', place || '.area', 'code', 'required');
    ELSIF length(area) > 120 THEN
      problems := problems || jsonb_build_object('field', place || '.area', 'code', 'length');
    ELSIF place = 'pickup' THEN
      pickup_area := area;
    ELSE
      delivery_area := area;
    END IF;
  END LOOP;
  IF nullif(p_details #>> '{quotationDeadline,local}', '') IS NULL THEN
    problems := problems || jsonb_build_object('field', 'quotationDeadline', 'code', 'required');
  ELSE
    SELECT * INTO deadline FROM trucker.resolve_window_end(p_details -> 'quotationDeadline', p_pickup_zone, 'quotationDeadline');
    IF deadline.problem IS NOT NULL THEN
      problems := problems || deadline.problem;
    ELSIF p_pickup_zone IS NULL THEN
      problems := problems || jsonb_build_object('field', 'quotationDeadline', 'code', 'needs_pickup_zone');
    ELSE
      deadline_local := deadline.local_time;
      deadline_offset_minutes := deadline.offset_minutes;
      deadline_at := deadline.instant;
    END IF;
  END IF;
END
$$;

-- What stands between a shipment and publication at a moment, by field. Completeness, the
-- order of times, the lead time when the deadline is being set, and the route when asked.
CREATE FUNCTION trucker.publication_problems(
  d trucker.shipment_draft, p_at timestamptz, p_check_lead boolean, p_check_route boolean,
  p_allow_fixtures boolean
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  RETURN problems;
END
$$;

-- Records what the clock and the registers say about one shipment, once. Called with the
-- organisation already locked. Expiry first: a shipment past its deadline expires, dated at its
-- deadline, and any open suspension ends with it. Otherwise each cause is checked on its own:
-- a failing cause with no open suspension opens one; a passing cause with an open one ends it.
-- Every transition writes one history entry; nothing is written when nothing changes. The route
-- is checked as configured in this database (fictional countries only where it is marked).
CREATE FUNCTION trucker.shipment_settle(p_shipment uuid, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  s trucker.shipment_draft;
  after_row trucker.shipment_draft;
  ended jsonb;
  v_cause text;
  failing boolean;
  is_open boolean;
  request text := nullif(current_setting('trucker.request_id', true), '');
BEGIN
  SELECT * INTO s FROM trucker.shipment_draft d WHERE d.id = p_shipment FOR UPDATE;
  IF NOT FOUND OR s.status <> 'published' THEN
    RETURN;
  END IF;
  IF s.deadline_at <= p_at THEN
    SELECT coalesce(jsonb_agg(x.cause ORDER BY x.cause), '[]'::jsonb) INTO ended
    FROM trucker.shipment_suspension x WHERE x.shipment_id = s.id AND x.ended_at IS NULL;
    UPDATE trucker.shipment_suspension x SET ended_at = s.deadline_at, ended_by = 'expiry'
    WHERE x.shipment_id = s.id AND x.ended_at IS NULL;
    UPDATE trucker.shipment_draft d
    SET status = 'expired', expired_at = s.deadline_at, version = d.version + 1, updated_at = p_at
    WHERE d.id = s.id RETURNING * INTO after_row;
    INSERT INTO trucker.audit_entry
      (occurred_at, organisation_id, action, record_type, record_id, request_id, before_values, after_values)
    VALUES (s.deadline_at, s.organisation_id, 'shipment.expired', 'shipment_draft', s.id, request,
            jsonb_build_object('status', 'published', 'publishedVersion', s.published_version),
            jsonb_build_object('status', 'expired', 'recordedAt', p_at, 'endedSuspensions', ended));
    RETURN;
  END IF;
  FOREACH v_cause IN ARRAY ARRAY['verification', 'route'] LOOP
    failing := CASE v_cause
      WHEN 'verification' THEN NOT trucker.organisation_publishable(s.organisation_id)
      ELSE trucker.route_check(s.pickup_country, s.delivery_country, true) ->> 'status' <> 'open' END;
    is_open := EXISTS (SELECT 1 FROM trucker.shipment_suspension x
                       WHERE x.shipment_id = s.id AND x.cause = v_cause AND x.ended_at IS NULL);
    IF failing AND NOT is_open THEN
      INSERT INTO trucker.shipment_suspension (shipment_id, organisation_id, cause, started_at)
      VALUES (s.id, s.organisation_id, v_cause, p_at);
      INSERT INTO trucker.audit_entry
        (occurred_at, organisation_id, action, record_type, record_id, request_id, before_values, after_values)
      VALUES (p_at, s.organisation_id, 'shipment.suspended', 'shipment_draft', s.id, request, NULL,
              jsonb_build_object('cause', v_cause, 'openCauses',
                (SELECT jsonb_agg(x.cause ORDER BY x.cause) FROM trucker.shipment_suspension x
                 WHERE x.shipment_id = s.id AND x.ended_at IS NULL)));
    ELSIF NOT failing AND is_open THEN
      UPDATE trucker.shipment_suspension x SET ended_at = p_at, ended_by = 'recheck'
      WHERE x.shipment_id = s.id AND x.cause = v_cause AND x.ended_at IS NULL;
      INSERT INTO trucker.audit_entry
        (occurred_at, organisation_id, action, record_type, record_id, request_id, before_values, after_values)
      VALUES (p_at, s.organisation_id, 'shipment.suspension_ended', 'shipment_draft', s.id, request,
              jsonb_build_object('cause', v_cause),
              jsonb_build_object('openCauses',
                coalesce((SELECT jsonb_agg(x.cause ORDER BY x.cause) FROM trucker.shipment_suspension x
                          WHERE x.shipment_id = s.id AND x.ended_at IS NULL), '[]'::jsonb)));
    END IF;
  END LOOP;
END
$$;

-- Every published shipment of one organisation, in one order. The caller holds the
-- organisation's lock.
CREATE FUNCTION trucker.shipment_settle_organisation(p_organisation uuid, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  one uuid;
BEGIN
  FOR one IN
    SELECT d.id FROM trucker.shipment_draft d
    WHERE d.organisation_id = p_organisation AND d.status = 'published' ORDER BY d.id
  LOOP
    PERFORM trucker.shipment_settle(one, p_at);
  END LOOP;
END
$$;

-- When an organisation's verification or capability changes (slice 9's staff functions, which
-- hold the organisation's lock), its published shipments are rechecked in the same transaction.
CREATE FUNCTION trucker.shipment_follow_organisation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'organisation' THEN
    PERFORM trucker.shipment_settle_organisation(NEW.id, trucker.clock_now());
  ELSE
    PERFORM trucker.shipment_settle_organisation(NEW.organisation_id, trucker.clock_now());
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER organisation_capability_follow AFTER INSERT OR UPDATE ON trucker.organisation_capability
  FOR EACH ROW EXECUTE FUNCTION trucker.shipment_follow_organisation();
CREATE TRIGGER organisation_status_follow AFTER UPDATE OF status ON trucker.organisation
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION trucker.shipment_follow_organisation();

-- The opening every publication function shares: who is asking, for which organisation, with
-- the organisation and then the shipment locked, the clock read after the locks, and the
-- shipment brought up to date. status: ok | unauthorized | not_found
CREATE FUNCTION trucker.shipment_enter(
  p_shipment uuid,
  OUT status text, OUT actor uuid, OUT org uuid, OUT at timestamptz, OUT row_found trucker.shipment_draft
)
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
  PERFORM 1 FROM trucker.shipment_draft d WHERE d.id = p_shipment AND d.organisation_id = org FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF trucker.request_person() IS DISTINCT FROM actor THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  at := trucker.clock_now();
  PERFORM trucker.shipment_settle(p_shipment, at);
  SELECT * INTO row_found FROM trucker.shipment_draft d WHERE d.id = p_shipment;
  status := 'ok';
END
$$;

-- A retry key seen before. status: none | repeated | key_conflict
CREATE FUNCTION trucker.shipment_retry_seen(
  p_actor uuid, p_key text, p_operation text, p_shipment uuid, p_hash text, p_at timestamptz,
  OUT status text, OUT resulting_version integer, OUT draft_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  earlier trucker.shipment_retry_key;
  keep integer;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT g.retry_key_retention_hours INTO keep FROM trucker.security_setting g;
  SELECT * INTO earlier FROM trucker.shipment_retry_key k WHERE k.person_id = p_actor AND k.key = p_key;
  IF FOUND AND earlier.created_at > p_at - make_interval(hours => keep) THEN
    IF earlier.operation <> p_operation OR earlier.request_hash <> p_hash
       OR (p_operation <> 'copy' AND earlier.draft_id <> p_shipment) THEN
      status := 'key_conflict';
    ELSE
      status := 'repeated';
      resulting_version := earlier.resulting_version;
      draft_id := earlier.draft_id;
    END IF;
    RETURN;
  END IF;
  IF FOUND THEN
    DELETE FROM trucker.shipment_retry_key k WHERE k.person_id = p_actor AND k.key = p_key;
  END IF;
  status := 'none';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Publishing a draft. status: published | repeated | unauthorized | not_found | not_draft
--   | discarded | conflict | not_eligible | invalid | limit | key_conflict
-- not_eligible: the organisation may not publish (slice 9's rule). invalid: detail lists every
-- problem by field. The draft's saved content is what is published, with the details given.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.publish_shipment(
  p_shipment uuid, p_expected_version integer, p_key text, p_details jsonb, p_allow_fixtures boolean,
  OUT status text, OUT version integer, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  g trucker.security_setting;
  d trucker.shipment_draft;
  r record;
  problems jsonb;
  hash text := trucker.content_hash(coalesce(p_details, 'null'::jsonb) || jsonb_build_object('_v', p_expected_version));
BEGIN
  IF p_shipment IS NULL OR p_details IS NULL OR jsonb_typeof(p_details) <> 'object' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO entered FROM trucker.shipment_enter(p_shipment);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  d := entered.row_found;
  version := d.version;
  SELECT * INTO seen FROM trucker.shipment_retry_seen(entered.actor, p_key, 'publish', p_shipment, hash, entered.at);
  IF seen.status <> 'none' THEN
    status := seen.status;
    version := coalesce(seen.resulting_version, d.version);
    RETURN;
  END IF;
  IF d.status = 'discarded' THEN
    status := 'discarded';
    RETURN;
  END IF;
  IF d.status <> 'draft' THEN
    status := 'not_draft';
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM d.version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF NOT trucker.organisation_publishable(entered.org) THEN
    status := 'not_eligible';
    RETURN;
  END IF;
  SELECT * INTO r FROM trucker.resolve_publication_details(p_details, d.pickup_time_zone, p_allow_fixtures);
  d.cargo_category := r.cargo_category;
  d.equipment_type := r.equipment_type;
  d.dangerous_goods := r.dangerous_goods;
  d.pickup_area := r.pickup_area;
  d.delivery_area := r.delivery_area;
  d.deadline_local := r.deadline_local;
  d.deadline_offset_minutes := r.deadline_offset_minutes;
  d.deadline_at := r.deadline_at;
  problems := r.problems || trucker.publication_problems(d, entered.at, true, true, p_allow_fixtures);
  IF problems <> '[]'::jsonb THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  SELECT * INTO g FROM trucker.security_setting;
  IF (SELECT count(*) FROM trucker.shipment_draft x
      WHERE x.organisation_id = entered.org AND x.status = 'published') >= g.published_shipment_limit THEN
    status := 'limit';
    detail := jsonb_build_object('limit', g.published_shipment_limit);
    RETURN;
  END IF;
  UPDATE trucker.shipment_draft x SET
    cargo_category = d.cargo_category, equipment_type = d.equipment_type, dangerous_goods = d.dangerous_goods,
    pickup_area = d.pickup_area, delivery_area = d.delivery_area,
    deadline_local = d.deadline_local, deadline_offset_minutes = d.deadline_offset_minutes,
    deadline_at = d.deadline_at,
    status = 'published', published_version = 1, published_at = entered.at,
    version = x.version + 1, updated_at = entered.at
  WHERE x.id = p_shipment RETURNING * INTO d;
  INSERT INTO trucker.shipment_publication_version
    (shipment_id, organisation_id, version_no, kind, carrier_values, created_at, created_by)
  VALUES (d.id, entered.org, 1, 'published', trucker.shipment_material_values(d), entered.at, entered.actor);
  INSERT INTO trucker.shipment_retry_key (person_id, key, operation, request_hash, draft_id, resulting_version, created_at)
  VALUES (entered.actor, p_key, 'publish', hash, d.id, d.version, entered.at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
     before_values, after_values)
  VALUES (entered.at, entered.actor, entered.org, 'shipment.published', 'shipment_draft', d.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('status', 'draft'),
          jsonb_build_object('status', 'published', 'publishedVersion', 1,
                             'carrierValues', trucker.shipment_material_values(d)));
  status := 'published';
  version := d.version;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Changing a published shipment. p_content is a draft's content with "publication" holding the
-- details. A change to what carriers would see, the deadline or the dangerous-goods answer is
-- material: a new published version. Any other change is minor. Everything publication needs is
-- checked again; the lead time only when the deadline moves; the route only when a country does.
-- status: changed | unchanged | repeated | unauthorized | not_found | not_published | conflict
--   | invalid | key_conflict          detail: {"material": true|false} when changed
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.change_published_shipment(
  p_shipment uuid, p_expected_version integer, p_key text, p_content jsonb, p_allow_fixtures boolean,
  OUT status text, OUT version integer, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  before_row trucker.shipment_draft;
  d trucker.shipment_draft;
  checked record;
  r record;
  problems jsonb;
  material boolean;
  hash text := trucker.content_hash(coalesce(p_content, 'null'::jsonb) || jsonb_build_object('_v', p_expected_version));
BEGIN
  IF p_shipment IS NULL OR p_content IS NULL OR jsonb_typeof(p_content) <> 'object'
     OR jsonb_typeof(p_content -> 'publication') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO entered FROM trucker.shipment_enter(p_shipment);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  before_row := entered.row_found;
  version := before_row.version;
  SELECT * INTO seen FROM trucker.shipment_retry_seen(entered.actor, p_key, 'change', p_shipment, hash, entered.at);
  IF seen.status <> 'none' THEN
    status := seen.status;
    version := coalesce(seen.resulting_version, before_row.version);
    RETURN;
  END IF;
  -- Expiry was settled first: a change that arrives after the deadline finds it expired.
  IF before_row.status <> 'published' THEN
    status := 'not_published';
    detail := jsonb_build_object('status', before_row.status);
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM before_row.version THEN
    status := 'conflict';
    RETURN;
  END IF;
  SELECT * INTO checked FROM trucker.resolve_shipment_content(p_content - 'publication', p_allow_fixtures);
  d := checked.resolved;
  SELECT * INTO r FROM trucker.resolve_publication_details(p_content -> 'publication', d.pickup_time_zone, p_allow_fixtures);
  d.id := before_row.id;
  d.organisation_id := before_row.organisation_id;
  d.status := before_row.status;
  d.cargo_category := r.cargo_category;
  d.equipment_type := r.equipment_type;
  d.dangerous_goods := r.dangerous_goods;
  d.pickup_area := r.pickup_area;
  d.delivery_area := r.delivery_area;
  d.deadline_local := r.deadline_local;
  d.deadline_offset_minutes := r.deadline_offset_minutes;
  d.deadline_at := r.deadline_at;
  problems := checked.problems || r.problems || trucker.publication_problems(
    d, entered.at,
    d.deadline_at IS DISTINCT FROM before_row.deadline_at,
    d.pickup_country IS DISTINCT FROM before_row.pickup_country
      OR d.delivery_country IS DISTINCT FROM before_row.delivery_country,
    p_allow_fixtures);
  -- A window already under way cannot be judged "in the past" against itself.
  IF d.pickup_from_at IS NOT DISTINCT FROM before_row.pickup_from_at THEN
    problems := (SELECT coalesce(jsonb_agg(p), '[]'::jsonb) FROM jsonb_array_elements(problems) p
                 WHERE NOT (p ->> 'field' = 'pickup.from' AND p ->> 'code' = 'in_past'));
  END IF;
  IF problems <> '[]'::jsonb THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  material := trucker.shipment_material_values(d) IS DISTINCT FROM trucker.shipment_material_values(before_row);
  -- Everything else a person can change is minor: the reference, the addresses, access notes.
  IF NOT material AND (d.shipper_reference, d.pickup_address, d.delivery_address,
                       d.pickup_access_notes, d.delivery_access_notes)
                      IS NOT DISTINCT FROM (before_row.shipper_reference, before_row.pickup_address,
                       before_row.delivery_address, before_row.pickup_access_notes,
                       before_row.delivery_access_notes) THEN
    status := 'unchanged';
    RETURN;
  END IF;
  UPDATE trucker.shipment_draft x SET
    shipper_reference = d.shipper_reference, cargo_description = d.cargo_description,
    gross_weight_kg = d.gross_weight_kg, pieces = d.pieces, packaging = d.packaging,
    equipment_needed = d.equipment_needed,
    pickup_address = d.pickup_address, pickup_country = d.pickup_country,
    pickup_time_zone = d.pickup_time_zone, pickup_access_notes = d.pickup_access_notes,
    pickup_from_local = d.pickup_from_local, pickup_from_offset_minutes = d.pickup_from_offset_minutes,
    pickup_from_at = d.pickup_from_at,
    pickup_until_local = d.pickup_until_local, pickup_until_offset_minutes = d.pickup_until_offset_minutes,
    pickup_until_at = d.pickup_until_at,
    delivery_address = d.delivery_address, delivery_country = d.delivery_country,
    delivery_time_zone = d.delivery_time_zone, delivery_access_notes = d.delivery_access_notes,
    delivery_from_local = d.delivery_from_local, delivery_from_offset_minutes = d.delivery_from_offset_minutes,
    delivery_from_at = d.delivery_from_at,
    delivery_until_local = d.delivery_until_local, delivery_until_offset_minutes = d.delivery_until_offset_minutes,
    delivery_until_at = d.delivery_until_at,
    cargo_category = d.cargo_category, equipment_type = d.equipment_type, dangerous_goods = d.dangerous_goods,
    pickup_area = d.pickup_area, delivery_area = d.delivery_area,
    deadline_local = d.deadline_local, deadline_offset_minutes = d.deadline_offset_minutes,
    deadline_at = d.deadline_at,
    published_version = x.published_version + CASE WHEN material THEN 1 ELSE 0 END,
    version = x.version + 1, updated_at = entered.at
  WHERE x.id = p_shipment RETURNING * INTO d;
  IF material THEN
    INSERT INTO trucker.shipment_publication_version
      (shipment_id, organisation_id, version_no, kind, carrier_values, created_at, created_by)
    VALUES (d.id, entered.org, d.published_version, 'changed', trucker.shipment_material_values(d),
            entered.at, entered.actor);
  END IF;
  INSERT INTO trucker.shipment_retry_key (person_id, key, operation, request_hash, draft_id, resulting_version, created_at)
  VALUES (entered.actor, p_key, 'change', hash, d.id, d.version, entered.at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
     before_values, after_values)
  VALUES (entered.at, entered.actor, entered.org,
          CASE WHEN material THEN 'shipment.version_created' ELSE 'shipment.updated' END,
          'shipment_draft', d.id, nullif(current_setting('trucker.request_id', true), ''),
          trucker.shipment_values(before_row), trucker.shipment_values(d));
  -- A place may have moved onto or off a closed route.
  PERFORM trucker.shipment_settle(d.id, entered.at);
  status := 'changed';
  version := d.version;
  detail := jsonb_build_object('material', material);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Withdrawing. Final: publishing again starts from a copy (PB-3).
-- status: withdrawn | already_withdrawn | repeated | unauthorized | not_found | not_published
--   | conflict | key_conflict
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.withdraw_shipment(
  p_shipment uuid, p_expected_version integer, p_key text,
  OUT status text, OUT version integer, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  d trucker.shipment_draft;
  ended jsonb;
  hash text := trucker.content_hash(jsonb_build_object('_v', p_expected_version));
BEGIN
  IF p_shipment IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO entered FROM trucker.shipment_enter(p_shipment);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  d := entered.row_found;
  version := d.version;
  SELECT * INTO seen FROM trucker.shipment_retry_seen(entered.actor, p_key, 'withdraw', p_shipment, hash, entered.at);
  IF seen.status <> 'none' THEN
    status := seen.status;
    version := coalesce(seen.resulting_version, d.version);
    RETURN;
  END IF;
  IF d.status = 'withdrawn' THEN
    status := 'already_withdrawn';
    RETURN;
  END IF;
  IF d.status <> 'published' THEN
    status := 'not_published';
    detail := jsonb_build_object('status', d.status);
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM d.version THEN
    status := 'conflict';
    RETURN;
  END IF;
  SELECT coalesce(jsonb_agg(x.cause ORDER BY x.cause), '[]'::jsonb) INTO ended
  FROM trucker.shipment_suspension x WHERE x.shipment_id = d.id AND x.ended_at IS NULL;
  UPDATE trucker.shipment_suspension x SET ended_at = entered.at, ended_by = 'withdrawal'
  WHERE x.shipment_id = d.id AND x.ended_at IS NULL;
  UPDATE trucker.shipment_draft x
  SET status = 'withdrawn', withdrawn_at = entered.at, version = x.version + 1, updated_at = entered.at
  WHERE x.id = p_shipment RETURNING * INTO d;
  INSERT INTO trucker.shipment_retry_key (person_id, key, operation, request_hash, draft_id, resulting_version, created_at)
  VALUES (entered.actor, p_key, 'withdraw', hash, d.id, d.version, entered.at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
     before_values, after_values)
  VALUES (entered.at, entered.actor, entered.org, 'shipment.withdrawn', 'shipment_draft', d.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('status', 'published', 'publishedVersion', d.published_version),
          jsonb_build_object('status', 'withdrawn', 'endedSuspensions', ended));
  status := 'withdrawn';
  version := d.version;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Publishing an expired shipment again, as a new version with a new deadline, after every check
-- passes again (PB-3). status: republished | repeated | unauthorized | not_found | not_expired
--   | conflict | not_eligible | invalid | limit | key_conflict
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.republish_shipment(
  p_shipment uuid, p_expected_version integer, p_key text, p_deadline jsonb, p_allow_fixtures boolean,
  OUT status text, OUT version integer, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  g trucker.security_setting;
  d trucker.shipment_draft;
  r record;
  problems jsonb;
  hash text := trucker.content_hash(coalesce(p_deadline, 'null'::jsonb) || jsonb_build_object('_v', p_expected_version));
BEGIN
  IF p_shipment IS NULL OR p_deadline IS NULL OR jsonb_typeof(p_deadline) <> 'object' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO entered FROM trucker.shipment_enter(p_shipment);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  d := entered.row_found;
  version := d.version;
  SELECT * INTO seen FROM trucker.shipment_retry_seen(entered.actor, p_key, 'republish', p_shipment, hash, entered.at);
  IF seen.status <> 'none' THEN
    status := seen.status;
    version := coalesce(seen.resulting_version, d.version);
    RETURN;
  END IF;
  IF d.status <> 'expired' THEN
    status := 'not_expired';
    detail := jsonb_build_object('status', d.status);
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM d.version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF NOT trucker.organisation_publishable(entered.org) THEN
    status := 'not_eligible';
    RETURN;
  END IF;
  -- Every detail is checked again against the catalogues as they are now.
  SELECT * INTO r FROM trucker.resolve_publication_details(
    jsonb_build_object('cargoCategory', d.cargo_category, 'equipmentType', d.equipment_type,
                       'dangerousGoods', d.dangerous_goods, 'pickupArea', d.pickup_area,
                       'deliveryArea', d.delivery_area, 'quotationDeadline', p_deadline),
    d.pickup_time_zone, p_allow_fixtures);
  d.deadline_local := r.deadline_local;
  d.deadline_offset_minutes := r.deadline_offset_minutes;
  d.deadline_at := r.deadline_at;
  problems := r.problems || trucker.publication_problems(d, entered.at, true, true, p_allow_fixtures);
  IF problems <> '[]'::jsonb THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  SELECT * INTO g FROM trucker.security_setting;
  IF (SELECT count(*) FROM trucker.shipment_draft x
      WHERE x.organisation_id = entered.org AND x.status = 'published') >= g.published_shipment_limit THEN
    status := 'limit';
    detail := jsonb_build_object('limit', g.published_shipment_limit);
    RETURN;
  END IF;
  UPDATE trucker.shipment_draft x SET
    deadline_local = d.deadline_local, deadline_offset_minutes = d.deadline_offset_minutes,
    deadline_at = d.deadline_at, status = 'published', expired_at = NULL,
    published_version = x.published_version + 1, published_at = entered.at,
    version = x.version + 1, updated_at = entered.at
  WHERE x.id = p_shipment RETURNING * INTO d;
  INSERT INTO trucker.shipment_publication_version
    (shipment_id, organisation_id, version_no, kind, carrier_values, created_at, created_by)
  VALUES (d.id, entered.org, d.published_version, 'republished', trucker.shipment_material_values(d),
          entered.at, entered.actor);
  INSERT INTO trucker.shipment_retry_key (person_id, key, operation, request_hash, draft_id, resulting_version, created_at)
  VALUES (entered.actor, p_key, 'republish', hash, d.id, d.version, entered.at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
     before_values, after_values)
  VALUES (entered.at, entered.actor, entered.org, 'shipment.republished', 'shipment_draft', d.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('status', 'expired'),
          jsonb_build_object('status', 'published', 'publishedVersion', d.published_version,
                             'carrierValues', trucker.shipment_material_values(d)));
  status := 'republished';
  version := d.version;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- A new draft from a withdrawn or expired shipment: its content and details, without a
-- deadline. status: copied | repeated | unauthorized | not_found | not_copyable | limit
--   | key_conflict
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.copy_shipment(
  p_shipment uuid, p_key text,
  OUT status text, OUT draft_id uuid, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  g trucker.security_setting;
  s trucker.shipment_draft;
  made trucker.shipment_draft;
  hash text := trucker.content_hash(jsonb_build_object('source', p_shipment));
BEGIN
  IF p_shipment IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO entered FROM trucker.shipment_enter(p_shipment);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  s := entered.row_found;
  SELECT * INTO seen FROM trucker.shipment_retry_seen(entered.actor, p_key, 'copy', p_shipment, hash, entered.at);
  IF seen.status <> 'none' THEN
    status := seen.status;
    draft_id := seen.draft_id;
    RETURN;
  END IF;
  IF s.status NOT IN ('withdrawn', 'expired') THEN
    status := 'not_copyable';
    detail := jsonb_build_object('status', s.status);
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('shipment.create:' || entered.org::text, 0));
  SELECT * INTO g FROM trucker.security_setting;
  IF (SELECT count(*) FROM trucker.shipment_draft d
      WHERE d.organisation_id = entered.org AND d.status = 'draft') >= g.shipment_open_draft_limit THEN
    status := 'limit';
    detail := jsonb_build_object('limit', g.shipment_open_draft_limit);
    RETURN;
  END IF;
  INSERT INTO trucker.shipment_draft (
    organisation_id, shipper_reference, cargo_description, gross_weight_kg, pieces, packaging,
    equipment_needed,
    pickup_address, pickup_country, pickup_time_zone, pickup_access_notes,
    pickup_from_local, pickup_from_offset_minutes, pickup_from_at,
    pickup_until_local, pickup_until_offset_minutes, pickup_until_at,
    delivery_address, delivery_country, delivery_time_zone, delivery_access_notes,
    delivery_from_local, delivery_from_offset_minutes, delivery_from_at,
    delivery_until_local, delivery_until_offset_minutes, delivery_until_at,
    cargo_category, equipment_type, dangerous_goods, pickup_area, delivery_area, copied_from,
    created_by, created_at, updated_at)
  VALUES (
    entered.org, s.shipper_reference, s.cargo_description, s.gross_weight_kg, s.pieces, s.packaging,
    s.equipment_needed,
    s.pickup_address, s.pickup_country, s.pickup_time_zone, s.pickup_access_notes,
    s.pickup_from_local, s.pickup_from_offset_minutes, s.pickup_from_at,
    s.pickup_until_local, s.pickup_until_offset_minutes, s.pickup_until_at,
    s.delivery_address, s.delivery_country, s.delivery_time_zone, s.delivery_access_notes,
    s.delivery_from_local, s.delivery_from_offset_minutes, s.delivery_from_at,
    s.delivery_until_local, s.delivery_until_offset_minutes, s.delivery_until_at,
    s.cargo_category, s.equipment_type, s.dangerous_goods, s.pickup_area, s.delivery_area, s.id,
    entered.actor, entered.at, entered.at)
  RETURNING * INTO made;
  INSERT INTO trucker.shipment_retry_key (person_id, key, operation, request_hash, draft_id, resulting_version, created_at)
  VALUES (entered.actor, p_key, 'copy', hash, made.id, made.version, entered.at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
     before_values, after_values)
  VALUES (entered.at, entered.actor, entered.org, 'shipment.copied', 'shipment_draft', made.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('copiedFrom', s.id), trucker.shipment_values(made));
  status := 'copied';
  draft_id := made.id;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Bringing the selected organisation's shipments up to date before they are read: one shipment,
-- or all of them when p_shipment is NULL. For any member. Writes only what settle writes.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.refresh_shipments(p_shipment uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  org uuid := trucker.request_organisation();
  t timestamptz;
BEGIN
  IF org IS NULL OR NOT trucker.is_member(org) THEN
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.organisation o WHERE o.id = org FOR SHARE;
  t := trucker.clock_now();
  IF p_shipment IS NULL THEN
    PERFORM trucker.shipment_settle_organisation(org, t);
  ELSIF EXISTS (SELECT 1 FROM trucker.shipment_draft d WHERE d.id = p_shipment AND d.organisation_id = org) THEN
    PERFORM trucker.shipment_settle(p_shipment, t);
  END IF;
END
$$;

-- What carriers would see of one of the selected organisation's shipments: the preview. NULL for
-- a draft that was never published, or one of another organisation.
CREATE FUNCTION trucker.shipment_carrier_view(p_shipment uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT trucker.shipment_carrier_values(d, trucker.clock_now())
  FROM trucker.shipment_draft d
  WHERE d.id = p_shipment AND d.organisation_id = trucker.request_organisation()
    AND trucker.is_member(d.organisation_id) AND d.published_version IS NOT NULL
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff, read-only. Reviewers and staff administrators. Each look is recorded.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.staff_shipment_list(
  p_token_hash text, p_request_id text,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  one record;
  page integer;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, NULL, 'staff.shipment_list', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT (trucker.staff_privileges(entered.staff_id) && ARRAY['reviewer', 'staff_admin']) THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.shipment_list', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'privilege_not_held'));
    status := 'forbidden';
    RETURN;
  END IF;
  -- What is due is recorded before it is listed, organisation by organisation, in one order.
  FOR one IN
    SELECT DISTINCT d.organisation_id AS org FROM trucker.shipment_draft d
    WHERE d.status = 'published' ORDER BY 1
  LOOP
    PERFORM 1 FROM trucker.organisation o WHERE o.id = one.org FOR SHARE;
    PERFORM trucker.shipment_settle_organisation(one.org, entered.at);
  END LOOP;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.shipment_list', 'done', NULL, p_request_id, '{}'::jsonb);
  SELECT g.shipment_page_size * 5 INTO page FROM trucker.security_setting g;
  SELECT coalesce(jsonb_agg(e ORDER BY (e ->> 'publishedAt') DESC, e ->> 'id'), '[]'::jsonb) INTO detail
  FROM (
    SELECT jsonb_build_object(
             'id', d.id, 'organisationId', d.organisation_id, 'legalName', o.legal_name,
             'state', trucker.shipment_state(d, entered.at), 'publishedVersion', d.published_version,
             'pickupCountry', d.pickup_country, 'deliveryCountry', d.delivery_country,
             'deadlineAt', d.deadline_at, 'publishedAt', d.published_at) AS e
    FROM trucker.shipment_draft d JOIN trucker.organisation o ON o.id = d.organisation_id
    WHERE d.published_version IS NOT NULL
    ORDER BY d.published_at DESC, d.id
    LIMIT page) q;
END
$$;

CREATE FUNCTION trucker.staff_shipment_view(
  p_token_hash text, p_shipment uuid, p_request_id text,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.shipment_draft;
  org_id uuid;
BEGIN
  SELECT d0.organisation_id INTO org_id FROM trucker.shipment_draft d0 WHERE d0.id = p_shipment;
  IF org_id IS NOT NULL THEN
    PERFORM 1 FROM trucker.organisation o WHERE o.id = org_id FOR SHARE;
  END IF;
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, NULL, 'staff.shipment_view', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT (trucker.staff_privileges(entered.staff_id) && ARRAY['reviewer', 'staff_admin']) THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.shipment_view', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'privilege_not_held', 'shipment', p_shipment));
    status := 'forbidden';
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment AND x.published_version IS NOT NULL;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM trucker.shipment_settle(d.id, entered.at);
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.shipment_view', 'done', NULL, p_request_id,
                              jsonb_build_object('shipment', d.id, 'organisation', d.organisation_id));
  detail := jsonb_build_object(
    'shipment', trucker.shipment_values(d) || jsonb_build_object('id', d.id, 'state', trucker.shipment_state(d, entered.at)),
    'organisation', (SELECT jsonb_build_object('id', o.id, 'legalName', o.legal_name, 'status', o.status,
                                               'countryCode', o.country_code)
                     FROM trucker.organisation o WHERE o.id = d.organisation_id),
    'carrierView', trucker.shipment_carrier_values(d, entered.at),
    'versions', coalesce((SELECT jsonb_agg(jsonb_build_object('versionNo', v.version_no, 'kind', v.kind,
                                                              'createdAt', v.created_at) ORDER BY v.version_no)
                          FROM trucker.shipment_publication_version v WHERE v.shipment_id = d.id), '[]'::jsonb),
    'suspensions', coalesce((SELECT jsonb_agg(jsonb_build_object('cause', s.cause, 'startedAt', s.started_at,
                                                                 'endedAt', s.ended_at, 'endedBy', s.ended_by)
                                              ORDER BY s.started_at, s.cause)
                             FROM trucker.shipment_suspension s WHERE s.shipment_id = d.id), '[]'::jsonb),
    'history', coalesce((SELECT jsonb_agg(jsonb_build_object('action', a.action, 'occurredAt', a.occurred_at,
                                                             'byStaff', a.actor_staff_id IS NOT NULL,
                                                             'bySystem', a.actor_person_id IS NULL AND a.actor_staff_id IS NULL)
                                          ORDER BY a.occurred_at, a.id)
                         FROM trucker.audit_entry a WHERE a.record_id = d.id), '[]'::jsonb));
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Slice 7's functions, replaced so that they act on drafts only. Each is the original with the
-- additions marked. A published, withdrawn or expired shipment answers "not_draft".
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.update_shipment_draft(
  p_draft uuid, p_expected_version integer, p_key text, p_content jsonb, p_allow_fixtures boolean,
  OUT status text, OUT version integer, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid;
  g trucker.security_setting;
  t timestamptz;
  hash text;
  earlier trucker.shipment_retry_key;
  checked record;
  before_row trucker.shipment_draft;
  after_row trucker.shipment_draft;
  r trucker.shipment_draft;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' OR p_draft IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  org := trucker.request_organisation();
  IF org IS NULL OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO before_row FROM trucker.shipment_draft d
  WHERE d.id = p_draft AND d.organisation_id = org FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  -- After any wait for the row: still signed in, still an administrator, and the time now.
  IF trucker.request_person() IS DISTINCT FROM actor THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  t := trucker.clock_now();
  SELECT * INTO g FROM trucker.security_setting;
  hash := trucker.content_hash(p_content);

  SELECT * INTO earlier FROM trucker.shipment_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  IF FOUND AND earlier.created_at > t - make_interval(hours => g.retry_key_retention_hours) THEN
    IF earlier.operation <> 'update' OR earlier.draft_id <> p_draft OR earlier.request_hash <> hash THEN
      status := 'key_conflict';
      RETURN;
    END IF;
    status := 'repeated';
    version := earlier.resulting_version;
    RETURN;
  END IF;
  IF FOUND THEN
    DELETE FROM trucker.shipment_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  END IF;

  IF before_row.status = 'discarded' THEN
    status := 'discarded';
    version := before_row.version;
    RETURN;
  END IF;
  -- A published, withdrawn or expired shipment is changed only by the publication functions.
  IF before_row.status <> 'draft' THEN
    status := 'not_draft';
    version := before_row.version;
    detail := jsonb_build_object('status', before_row.status);
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM before_row.version THEN
    status := 'conflict';
    version := before_row.version;
    RETURN;
  END IF;
  SELECT * INTO checked FROM trucker.resolve_shipment_content(p_content, p_allow_fixtures);
  IF checked.problems <> '[]'::jsonb THEN
    status := 'invalid';
    detail := checked.problems;
    RETURN;
  END IF;

  r := checked.resolved;
  UPDATE trucker.shipment_draft d SET
    shipper_reference = r.shipper_reference, cargo_description = r.cargo_description,
    gross_weight_kg = r.gross_weight_kg, pieces = r.pieces, packaging = r.packaging,
    equipment_needed = r.equipment_needed,
    pickup_address = r.pickup_address, pickup_country = r.pickup_country,
    pickup_time_zone = r.pickup_time_zone, pickup_access_notes = r.pickup_access_notes,
    pickup_from_local = r.pickup_from_local, pickup_from_offset_minutes = r.pickup_from_offset_minutes,
    pickup_from_at = r.pickup_from_at,
    pickup_until_local = r.pickup_until_local, pickup_until_offset_minutes = r.pickup_until_offset_minutes,
    pickup_until_at = r.pickup_until_at,
    delivery_address = r.delivery_address, delivery_country = r.delivery_country,
    delivery_time_zone = r.delivery_time_zone, delivery_access_notes = r.delivery_access_notes,
    delivery_from_local = r.delivery_from_local, delivery_from_offset_minutes = r.delivery_from_offset_minutes,
    delivery_from_at = r.delivery_from_at,
    delivery_until_local = r.delivery_until_local, delivery_until_offset_minutes = r.delivery_until_offset_minutes,
    delivery_until_at = r.delivery_until_at,
    version = d.version + 1, updated_at = t
  WHERE d.id = p_draft
  RETURNING * INTO after_row;
  INSERT INTO trucker.shipment_retry_key (person_id, key, operation, request_hash, draft_id, resulting_version, created_at)
  VALUES (actor, p_key, 'update', hash, p_draft, after_row.version, t);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES
    (t, actor, org, 'shipment.updated', 'shipment_draft', p_draft,
     nullif(current_setting('trucker.request_id', true), ''),
     trucker.shipment_values(before_row), trucker.shipment_values(after_row));
  status := 'updated';
  version := after_row.version;
END
$$;

CREATE OR REPLACE FUNCTION trucker.discard_shipment_draft(
  p_draft uuid, p_expected_version integer, p_key text,
  OUT status text, OUT version integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid;
  g trucker.security_setting;
  t timestamptz;
  earlier trucker.shipment_retry_key;
  before_row trucker.shipment_draft;
  after_row trucker.shipment_draft;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' OR p_draft IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  org := trucker.request_organisation();
  IF org IS NULL OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO before_row FROM trucker.shipment_draft d
  WHERE d.id = p_draft AND d.organisation_id = org FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF trucker.request_person() IS DISTINCT FROM actor THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  t := trucker.clock_now();
  SELECT * INTO g FROM trucker.security_setting;
  version := before_row.version;

  SELECT * INTO earlier FROM trucker.shipment_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  IF FOUND AND earlier.created_at > t - make_interval(hours => g.retry_key_retention_hours) THEN
    IF earlier.operation <> 'discard' OR earlier.draft_id <> p_draft THEN
      status := 'key_conflict';
      RETURN;
    END IF;
    status := 'repeated';
    RETURN;
  END IF;
  IF FOUND THEN
    DELETE FROM trucker.shipment_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  END IF;

  IF before_row.status = 'discarded' THEN
    status := 'already_discarded';
    RETURN;
  END IF;
  -- Only a draft is discarded; a published shipment is withdrawn instead.
  IF before_row.status <> 'draft' THEN
    status := 'not_draft';
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM before_row.version THEN
    status := 'conflict';
    RETURN;
  END IF;
  UPDATE trucker.shipment_draft d
  SET status = 'discarded', discarded_at = t, version = d.version + 1, updated_at = t
  WHERE d.id = p_draft
  RETURNING * INTO after_row;
  INSERT INTO trucker.shipment_retry_key (person_id, key, operation, request_hash, draft_id, resulting_version, created_at)
  VALUES (actor, p_key, 'discard', '', p_draft, after_row.version, t);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES
    (t, actor, org, 'shipment.discarded', 'shipment_draft', p_draft,
     nullif(current_setting('trucker.request_id', true), ''),
     trucker.shipment_values(before_row), trucker.shipment_values(after_row));
  status := 'discarded';
  version := after_row.version;
END
$$;

-- The offsets of each stored time that occurs twice, now with the quotation deadline.
CREATE OR REPLACE FUNCTION trucker.offset_choices(p_draft uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(jsonb_object_agg(e.name, e.offsets), '{}'::jsonb)
  FROM trucker.shipment_draft d
  CROSS JOIN LATERAL (VALUES
    ('pickup.from', d.pickup_from_local, d.pickup_time_zone),
    ('pickup.until', d.pickup_until_local, d.pickup_time_zone),
    ('delivery.from', d.delivery_from_local, d.delivery_time_zone),
    ('delivery.until', d.delivery_until_local, d.delivery_time_zone),
    ('quotationDeadline', d.deadline_local, d.pickup_time_zone)) w (name, wall, zone)
  CROSS JOIN LATERAL (
    SELECT w.name, to_jsonb(array_agg(c.offset_minutes ORDER BY c.instant)) AS offsets, count(*) AS found
    FROM trucker.local_time_candidates(w.wall, w.zone) c
    WHERE w.wall IS NOT NULL AND w.zone IS NOT NULL) e
  WHERE d.id = p_draft
    AND d.organisation_id = trucker.request_organisation()
    AND e.found > 1
$$;

-- The list, now with every state, judged at the moment of reading.
DROP FUNCTION trucker.list_shipment_drafts(text, uuid);
CREATE FUNCTION trucker.list_shipment_drafts(p_status text, p_after uuid)
RETURNS TABLE (
  id uuid, status text, version integer, shipper_reference text, cargo_description text,
  pickup_country text, delivery_country text, created_at timestamptz, updated_at timestamptz,
  more boolean, published_version integer, deadline_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  org uuid := trucker.request_organisation();
  page integer;
  start_before bigint;
  t timestamptz := trucker.clock_now();
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('draft', 'discarded', 'published', 'withdrawn', 'expired', 'all') THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF org IS NULL THEN
    RETURN;
  END IF;
  SELECT g.shipment_page_size INTO page FROM trucker.security_setting g;
  IF p_after IS NOT NULL THEN
    SELECT d.list_position INTO start_before FROM trucker.shipment_draft d
    WHERE d.id = p_after AND d.organisation_id = org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown cursor' USING ERRCODE = 'TR010';
    END IF;
  END IF;
  RETURN QUERY
    SELECT q.id, q.state, q.version, q.shipper_reference, q.cargo_description,
           q.pickup_country, q.delivery_country, q.created_at, q.updated_at,
           count(*) OVER () > page, q.published_version, q.deadline_at
    FROM (
      SELECT d.*, trucker.shipment_state(d, t) AS state FROM trucker.shipment_draft d
      WHERE d.organisation_id = org
        -- Judged by state at this moment: a shipment past its deadline lists as expired, and a
        -- suspended one is published.
        AND (p_status = 'all'
             OR (CASE trucker.shipment_state(d, t) WHEN 'suspended' THEN 'published'
                 ELSE trucker.shipment_state(d, t) END) = p_status)
        AND (start_before IS NULL OR d.list_position < start_before)
      ORDER BY d.list_position DESC
      LIMIT page + 1) q
    ORDER BY q.list_position DESC
    LIMIT page;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may run what.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.list_shipment_drafts(text, uuid),
  trucker.publish_shipment(uuid, integer, text, jsonb, boolean),
  trucker.change_published_shipment(uuid, integer, text, jsonb, boolean),
  trucker.withdraw_shipment(uuid, integer, text),
  trucker.republish_shipment(uuid, integer, text, jsonb, boolean),
  trucker.copy_shipment(uuid, text),
  trucker.refresh_shipments(uuid),
  trucker.shipment_carrier_view(uuid),
  trucker.staff_shipment_list(text, text),
  trucker.staff_shipment_view(text, uuid, text)
TO trucker_app;
