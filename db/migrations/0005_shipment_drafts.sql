-- 0005_shipment_drafts
-- Shipment drafts for a shipper organisation: create, change, list, discard. Nothing here
-- publishes a shipment, and nothing outside the organisation can see a draft.
--
-- Decisions recorded on 13 November 2026 (docs/delivery/SHIPMENT_DRAFTS_SLICE_7_SCOPE.md):
--   * an unverified organisation may save private drafts; a draft grants no publication or
--     commercial right;
--   * cargo is described in free text; weight and pieces are optional numbers with units and
--     bounds; no category, equipment catalogue, declared value, attachment or site contact;
--   * a draft is saved whether or not its route is open. The route check reports configured
--     availability only. It is not legal clearance and gives no right;
--   * discarding keeps the record and its history;
--   * 200 open drafts per organisation and 20 per page are development defaults that need
--     review before production.
--
-- No country operating state, time zone or lane ships: every register below is empty after
-- this migration, so outside local development and test every route is closed.
--
-- As in 0004: every function names its search path with pg_temp last and is closed to
-- PUBLIC; a function that changes something takes its locks, then reads the clock, then
-- decides; the API's role writes nothing here except through these functions.

-- ---------------------------------------------------------------------------------------------
-- Registers: where goods may move. A row that belongs to a fixture country exists only where
-- fixture countries may (0003: a database marked local-development or test).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.country
  ADD COLUMN operating_state text NOT NULL DEFAULT 'closed'
    CHECK (operating_state IN ('closed', 'enabled'));
COMMENT ON COLUMN trucker.country.operating_state IS
  'Whether shipments may start, end or pass here. Separate from registration_state. Configured availability only: not a statement about legal clearance.';

CREATE TABLE trucker.country_time_zone (
  country_code text NOT NULL REFERENCES trucker.country (code),
  zone_name text NOT NULL CHECK (length(zone_name) BETWEEN 1 AND 64),
  PRIMARY KEY (country_code, zone_name)
);
COMMENT ON TABLE trucker.country_time_zone IS
  'Named time zones a place in a country may use. A name, never an offset.';

CREATE FUNCTION trucker.guard_time_zone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = NEW.zone_name) THEN
    RAISE EXCEPTION 'the database does not know the time zone "%"', NEW.zone_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER country_time_zone_guard BEFORE INSERT OR UPDATE ON trucker.country_time_zone
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_time_zone();

-- A lane is a direction: origin to destination. A domestic lane has the same country twice.
CREATE TABLE trucker.lane (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_country text NOT NULL REFERENCES trucker.country (code),
  destination_country text NOT NULL REFERENCES trucker.country (code),
  state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'enabled')),
  CONSTRAINT lane_once UNIQUE (origin_country, destination_country)
);

-- Countries crossed on the way, in order.
CREATE TABLE trucker.lane_transit (
  lane_id uuid NOT NULL REFERENCES trucker.lane (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 1),
  country_code text NOT NULL REFERENCES trucker.country (code),
  PRIMARY KEY (lane_id, position),
  CONSTRAINT lane_transit_once UNIQUE (lane_id, country_code)
);

GRANT SELECT ON trucker.country_time_zone, trucker.lane, trucker.lane_transit TO trucker_app;

-- ---------------------------------------------------------------------------------------------
-- Protected settings added for this slice (0004, trucker.security_setting).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.security_setting
  ADD COLUMN shipment_open_draft_limit integer NOT NULL DEFAULT 200
    CHECK (shipment_open_draft_limit BETWEEN 1 AND 10000),
  ADD COLUMN shipment_page_size integer NOT NULL DEFAULT 20
    CHECK (shipment_page_size BETWEEN 1 AND 100),
  ADD COLUMN retry_key_retention_hours integer NOT NULL DEFAULT 24
    CHECK (retry_key_retention_hours BETWEEN 1 AND 720);
-- New limits have not been reviewed, whatever was recorded before.
UPDATE trucker.security_setting SET reviewed_for_production = false;

-- ---------------------------------------------------------------------------------------------
-- The draft. Everything a person gives is optional and kept as given. A time is kept as the
-- wall-clock time typed; the instant is filled in only when the place has a time zone and the
-- time resolves there. Nothing is invented for what is missing.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.shipment_draft (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Order of creation. The list is read in this order because it never changes.
  list_position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'discarded')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),

  shipper_reference text CHECK (shipper_reference IS NULL OR length(btrim(shipper_reference)) BETWEEN 1 AND 64),
  cargo_description text CHECK (cargo_description IS NULL OR length(btrim(cargo_description)) BETWEEN 1 AND 2000),
  -- Kilograms: more than nothing, at most 100,000, to the gram.
  gross_weight_kg numeric(9, 3) CHECK (gross_weight_kg IS NULL OR (gross_weight_kg > 0 AND gross_weight_kg <= 100000)),
  -- Whole pieces: 1 to 100,000.
  pieces integer CHECK (pieces IS NULL OR pieces BETWEEN 1 AND 100000),
  packaging text CHECK (packaging IS NULL OR length(btrim(packaging)) BETWEEN 1 AND 200),
  equipment_needed text CHECK (equipment_needed IS NULL OR length(btrim(equipment_needed)) BETWEEN 1 AND 500),

  pickup_address text CHECK (pickup_address IS NULL OR length(btrim(pickup_address)) BETWEEN 1 AND 500),
  pickup_country text REFERENCES trucker.country (code),
  pickup_time_zone text,
  pickup_access_notes text CHECK (pickup_access_notes IS NULL OR length(btrim(pickup_access_notes)) BETWEEN 1 AND 1000),
  pickup_from_local timestamp,
  pickup_from_offset_minutes integer,
  pickup_from_at timestamptz,
  pickup_until_local timestamp,
  pickup_until_offset_minutes integer,
  pickup_until_at timestamptz,

  delivery_address text CHECK (delivery_address IS NULL OR length(btrim(delivery_address)) BETWEEN 1 AND 500),
  delivery_country text REFERENCES trucker.country (code),
  delivery_time_zone text,
  delivery_access_notes text CHECK (delivery_access_notes IS NULL OR length(btrim(delivery_access_notes)) BETWEEN 1 AND 1000),
  delivery_from_local timestamp,
  delivery_from_offset_minutes integer,
  delivery_from_at timestamptz,
  delivery_until_local timestamp,
  delivery_until_offset_minutes integer,
  delivery_until_at timestamptz,

  created_by uuid NOT NULL REFERENCES trucker.person (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  discarded_at timestamptz,

  CONSTRAINT shipment_draft_discard_complete CHECK ((status = 'discarded') = (discarded_at IS NOT NULL)),
  -- A time zone belongs to a country, and must be one configured for it.
  CONSTRAINT shipment_draft_pickup_zone FOREIGN KEY (pickup_country, pickup_time_zone)
    REFERENCES trucker.country_time_zone (country_code, zone_name),
  CONSTRAINT shipment_draft_delivery_zone FOREIGN KEY (delivery_country, delivery_time_zone)
    REFERENCES trucker.country_time_zone (country_code, zone_name),
  CONSTRAINT shipment_draft_pickup_zone_needs_country CHECK (pickup_time_zone IS NULL OR pickup_country IS NOT NULL),
  CONSTRAINT shipment_draft_delivery_zone_needs_country CHECK (delivery_time_zone IS NULL OR delivery_country IS NOT NULL),
  -- An instant exists only for a typed time in a known zone, with the offset it was read at.
  CONSTRAINT shipment_draft_pickup_from_resolved CHECK (
    (pickup_from_at IS NULL AND pickup_from_offset_minutes IS NULL)
    OR (pickup_from_at IS NOT NULL AND pickup_from_offset_minutes IS NOT NULL
        AND pickup_from_local IS NOT NULL AND pickup_time_zone IS NOT NULL)),
  CONSTRAINT shipment_draft_pickup_until_resolved CHECK (
    (pickup_until_at IS NULL AND pickup_until_offset_minutes IS NULL)
    OR (pickup_until_at IS NOT NULL AND pickup_until_offset_minutes IS NOT NULL
        AND pickup_until_local IS NOT NULL AND pickup_time_zone IS NOT NULL)),
  CONSTRAINT shipment_draft_delivery_from_resolved CHECK (
    (delivery_from_at IS NULL AND delivery_from_offset_minutes IS NULL)
    OR (delivery_from_at IS NOT NULL AND delivery_from_offset_minutes IS NOT NULL
        AND delivery_from_local IS NOT NULL AND delivery_time_zone IS NOT NULL)),
  CONSTRAINT shipment_draft_delivery_until_resolved CHECK (
    (delivery_until_at IS NULL AND delivery_until_offset_minutes IS NULL)
    OR (delivery_until_at IS NOT NULL AND delivery_until_offset_minutes IS NOT NULL
        AND delivery_until_local IS NOT NULL AND delivery_time_zone IS NOT NULL)),
  CONSTRAINT shipment_draft_pickup_window CHECK (pickup_until_at IS NULL OR pickup_from_at IS NULL OR pickup_until_at >= pickup_from_at),
  CONSTRAINT shipment_draft_delivery_window CHECK (delivery_until_at IS NULL OR delivery_from_at IS NULL OR delivery_until_at >= delivery_from_at),
  CONSTRAINT shipment_draft_delivery_after_pickup CHECK (delivery_until_at IS NULL OR pickup_from_at IS NULL OR delivery_until_at >= pickup_from_at)
);
CREATE INDEX shipment_draft_list_idx ON trucker.shipment_draft (organisation_id, list_position DESC);

COMMENT ON TABLE trucker.shipment_draft IS
  'A private draft. It publishes nothing, is seen by nobody outside its organisation, and grants no publication or commercial right.';

-- Which request produced which change, so that a request whose answer was lost can be sent
-- again and recognised. A reference only, never a copy of an answer. Closed to the API's role.
CREATE TABLE trucker.shipment_retry_key (
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9._-]{16,128}$'),
  operation text NOT NULL CHECK (operation IN ('create', 'update', 'discard')),
  request_hash text NOT NULL,
  draft_id uuid NOT NULL REFERENCES trucker.shipment_draft (id),
  resulting_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (person_id, key)
);

-- History: the same table as organisations, with the new kinds of entry.
ALTER TABLE trucker.audit_entry
  DROP CONSTRAINT audit_entry_action_check,
  ADD CONSTRAINT audit_entry_action_check CHECK (action IN (
    'organisation.created', 'organisation.updated',
    'shipment.created', 'shipment.updated', 'shipment.discarded')),
  DROP CONSTRAINT audit_entry_record_type_check,
  ADD CONSTRAINT audit_entry_record_type_check CHECK (record_type IN ('organisation', 'shipment_draft'));
CREATE INDEX audit_entry_record_idx ON trucker.audit_entry (record_id, occurred_at);

-- ---------------------------------------------------------------------------------------------
-- Row security. A request sees the drafts of the one organisation it selected, and only if
-- the person is a member of it. The API's role may read; it may write nothing.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.shipment_draft ENABLE ROW LEVEL SECURITY;
CREATE POLICY shipment_draft_read ON trucker.shipment_draft FOR SELECT TO trucker_app
  USING (organisation_id = trucker.request_organisation());
GRANT SELECT ON trucker.shipment_draft TO trucker_app;

ALTER TABLE trucker.shipment_retry_key ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.shipment_retry_key FROM trucker_app, PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Building blocks. None is callable by the API's role.
-- ---------------------------------------------------------------------------------------------

-- Whether a country can be used at all by this request: it exists, and if it is a fixture,
-- fixtures were asked for and this database is marked for them.
CREATE FUNCTION trucker.country_available(p_code text, p_allow_fixtures boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trucker.country c
    WHERE c.code = p_code
      AND (NOT c.fixture
           OR (coalesce(p_allow_fixtures, false)
               AND (SELECT e.kind FROM trucker.environment e) IN ('local-development', 'test'))))
$$;

-- The instants at which a wall-clock time occurs in a zone: none (the clocks skipped it), one,
-- or two (the clocks went back over it), with the offset from UTC of each, in minutes.
CREATE FUNCTION trucker.local_time_candidates(p_local timestamp, p_zone text)
RETURNS TABLE (instant timestamptz, offset_minutes integer)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH guess AS (SELECT p_local AT TIME ZONE p_zone AS g),
       offsets AS (
         SELECT DISTINCT (x AT TIME ZONE p_zone) - (x AT TIME ZONE 'UTC') AS o
         FROM guess CROSS JOIN LATERAL (VALUES (g - interval '1 day'), (g), (g + interval '1 day')) v (x)),
       candidates AS (SELECT (p_local AT TIME ZONE 'UTC') - o AS t, o FROM offsets)
  SELECT t, (extract(epoch FROM o) / 60)::integer
  FROM candidates
  WHERE (t AT TIME ZONE p_zone) = p_local
  ORDER BY t
$$;

-- For one draft of the organisation this request selected: the two offsets of each stored
-- wall-clock time that occurs twice in its place's zone, so that a form can show the choice
-- that was made. Times that occur once, and places with no zone, are left out. It takes no
-- time from its caller and shows nothing of another organisation's drafts.
CREATE FUNCTION trucker.offset_choices(p_draft uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(jsonb_object_agg(e.name, e.offsets), '{}'::jsonb)
  FROM trucker.shipment_draft d
  CROSS JOIN LATERAL (VALUES
    ('pickup.from', d.pickup_from_local, d.pickup_time_zone),
    ('pickup.until', d.pickup_until_local, d.pickup_time_zone),
    ('delivery.from', d.delivery_from_local, d.delivery_time_zone),
    ('delivery.until', d.delivery_until_local, d.delivery_time_zone)) w (name, wall, zone)
  CROSS JOIN LATERAL (
    SELECT w.name, to_jsonb(array_agg(c.offset_minutes ORDER BY c.instant)) AS offsets, count(*) AS found
    FROM trucker.local_time_candidates(w.wall, w.zone) c
    WHERE w.wall IS NOT NULL AND w.zone IS NOT NULL) e
  WHERE d.id = p_draft
    AND d.organisation_id = trucker.request_organisation()
    AND e.found > 1
$$;

-- One end of a window, as given: {"local": "YYYY-MM-DDTHH:MM", "offsetMinutes": n}.
--   no time given        nothing is stored
--   no zone for the place the typed time is kept; no instant is made up
--   the time does not exist there            problem time_does_not_exist
--   the time occurs twice and none is chosen problem time_ambiguous, with both offsets
-- A chosen offset is used only when the time occurs twice.
CREATE FUNCTION trucker.resolve_window_end(
  p_end jsonb, p_zone text, p_field text,
  OUT local_time timestamp, OUT offset_minutes integer, OUT instant timestamptz, OUT problem jsonb
)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  typed text := nullif(p_end ->> 'local', '');
  chosen integer;
  found integer;
  offsets integer[];
BEGIN
  IF typed IS NULL THEN
    RETURN;
  END IF;
  IF typed !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' THEN
    problem := jsonb_build_object('field', p_field, 'code', 'time_invalid');
    RETURN;
  END IF;
  BEGIN
    local_time := replace(typed, 'T', ' ')::timestamp;
  EXCEPTION WHEN others THEN
    problem := jsonb_build_object('field', p_field, 'code', 'time_invalid');
    RETURN;
  END;
  IF p_zone IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*)::integer, array_agg(c.offset_minutes ORDER BY c.instant) INTO found, offsets
  FROM trucker.local_time_candidates(local_time, p_zone) c;
  IF found = 0 THEN
    problem := jsonb_build_object('field', p_field, 'code', 'time_does_not_exist');
    RETURN;
  END IF;
  IF found = 1 THEN
    offset_minutes := offsets[1];
  ELSE
    IF jsonb_typeof(p_end -> 'offsetMinutes') = 'number' THEN
      chosen := (p_end ->> 'offsetMinutes')::integer;
    END IF;
    IF chosen IS NULL OR NOT chosen = ANY (offsets) THEN
      problem := jsonb_build_object('field', p_field, 'code', 'time_ambiguous', 'offsets', to_jsonb(offsets));
      RETURN;
    END IF;
    offset_minutes := chosen;
  END IF;
  SELECT c.instant INTO instant
  FROM trucker.local_time_candidates(local_time, p_zone) c
  WHERE c.offset_minutes = resolve_window_end.offset_minutes;
END
$$;

-- What a person gave, checked and turned into a row. `problems` lists what is wrong, by
-- field; when it is not empty nothing may be saved. Text is kept exactly as given; an empty
-- text is nothing.
CREATE FUNCTION trucker.resolve_shipment_content(
  p_content jsonb, p_allow_fixtures boolean,
  OUT resolved trucker.shipment_draft, OUT problems jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  place text;
  given jsonb;
  country text;
  zone text;
  from_end record;
  until_end record;
  weight text;
  count_text text;
BEGIN
  problems := '[]'::jsonb;
  IF p_content IS NULL OR jsonb_typeof(p_content) <> 'object' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  resolved.shipper_reference := nullif(p_content ->> 'shipperReference', '');
  resolved.cargo_description := nullif(p_content ->> 'cargoDescription', '');
  resolved.packaging := nullif(p_content ->> 'packaging', '');
  resolved.equipment_needed := nullif(p_content ->> 'equipmentNeeded', '');

  weight := nullif(p_content ->> 'grossWeightKg', '');
  IF weight IS NOT NULL THEN
    IF weight !~ '^[0-9]{1,6}(\.[0-9]{1,3})?$' OR weight::numeric <= 0 OR weight::numeric > 100000 THEN
      problems := problems || jsonb_build_object('field', 'grossWeightKg', 'code', 'out_of_range');
    ELSE
      resolved.gross_weight_kg := weight::numeric;
    END IF;
  END IF;
  count_text := nullif(p_content ->> 'pieces', '');
  IF count_text IS NOT NULL THEN
    IF count_text !~ '^[0-9]{1,6}$' OR count_text::integer < 1 OR count_text::integer > 100000 THEN
      problems := problems || jsonb_build_object('field', 'pieces', 'code', 'out_of_range');
    ELSE
      resolved.pieces := count_text::integer;
    END IF;
  END IF;

  FOREACH place IN ARRAY ARRAY['pickup', 'delivery'] LOOP
    given := coalesce(p_content -> place, '{}'::jsonb);
    country := nullif(given ->> 'countryCode', '');
    zone := nullif(given ->> 'timeZone', '');
    IF country IS NOT NULL AND NOT trucker.country_available(country, p_allow_fixtures) THEN
      problems := problems || jsonb_build_object('field', place || '.countryCode', 'code', 'country_unavailable');
      country := NULL;
      zone := NULL;
    ELSIF zone IS NOT NULL AND country IS NULL THEN
      problems := problems || jsonb_build_object('field', place || '.timeZone', 'code', 'zone_needs_country');
      zone := NULL;
    ELSIF zone IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM trucker.country_time_zone z
            WHERE z.country_code = country AND z.zone_name = zone) THEN
      problems := problems || jsonb_build_object('field', place || '.timeZone', 'code', 'zone_not_configured');
      zone := NULL;
    END IF;
    SELECT * INTO from_end FROM trucker.resolve_window_end(given -> 'from', zone, place || '.from');
    SELECT * INTO until_end FROM trucker.resolve_window_end(given -> 'until', zone, place || '.until');
    IF from_end.problem IS NOT NULL THEN
      problems := problems || from_end.problem;
    END IF;
    IF until_end.problem IS NOT NULL THEN
      problems := problems || until_end.problem;
    END IF;
    IF from_end.instant IS NOT NULL AND until_end.instant IS NOT NULL AND until_end.instant < from_end.instant THEN
      problems := problems || jsonb_build_object('field', place || '.until', 'code', 'window_order');
    END IF;
    IF place = 'pickup' THEN
      resolved.pickup_address := nullif(given ->> 'address', '');
      resolved.pickup_country := country;
      resolved.pickup_time_zone := zone;
      resolved.pickup_access_notes := nullif(given ->> 'accessNotes', '');
      resolved.pickup_from_local := from_end.local_time;
      resolved.pickup_from_offset_minutes := from_end.offset_minutes;
      resolved.pickup_from_at := from_end.instant;
      resolved.pickup_until_local := until_end.local_time;
      resolved.pickup_until_offset_minutes := until_end.offset_minutes;
      resolved.pickup_until_at := until_end.instant;
    ELSE
      resolved.delivery_address := nullif(given ->> 'address', '');
      resolved.delivery_country := country;
      resolved.delivery_time_zone := zone;
      resolved.delivery_access_notes := nullif(given ->> 'accessNotes', '');
      resolved.delivery_from_local := from_end.local_time;
      resolved.delivery_from_offset_minutes := from_end.offset_minutes;
      resolved.delivery_from_at := from_end.instant;
      resolved.delivery_until_local := until_end.local_time;
      resolved.delivery_until_offset_minutes := until_end.offset_minutes;
      resolved.delivery_until_at := until_end.instant;
    END IF;
  END LOOP;

  IF resolved.delivery_until_at IS NOT NULL AND resolved.pickup_from_at IS NOT NULL
     AND resolved.delivery_until_at < resolved.pickup_from_at THEN
    problems := problems || jsonb_build_object('field', 'delivery.until', 'code', 'delivery_before_pickup');
  END IF;

  -- Lengths, so that a refusal names the field instead of failing on a table constraint.
  IF length(btrim(coalesce(resolved.shipper_reference, 'x'))) NOT BETWEEN 1 AND 64 THEN
    problems := problems || jsonb_build_object('field', 'shipperReference', 'code', 'length');
  END IF;
  IF length(btrim(coalesce(resolved.cargo_description, 'x'))) NOT BETWEEN 1 AND 2000 THEN
    problems := problems || jsonb_build_object('field', 'cargoDescription', 'code', 'length');
  END IF;
  IF length(btrim(coalesce(resolved.packaging, 'x'))) NOT BETWEEN 1 AND 200 THEN
    problems := problems || jsonb_build_object('field', 'packaging', 'code', 'length');
  END IF;
  IF length(btrim(coalesce(resolved.equipment_needed, 'x'))) NOT BETWEEN 1 AND 500 THEN
    problems := problems || jsonb_build_object('field', 'equipmentNeeded', 'code', 'length');
  END IF;
  IF length(btrim(coalesce(resolved.pickup_address, 'x'))) NOT BETWEEN 1 AND 500 THEN
    problems := problems || jsonb_build_object('field', 'pickup.address', 'code', 'length');
  END IF;
  IF length(btrim(coalesce(resolved.delivery_address, 'x'))) NOT BETWEEN 1 AND 500 THEN
    problems := problems || jsonb_build_object('field', 'delivery.address', 'code', 'length');
  END IF;
  IF length(btrim(coalesce(resolved.pickup_access_notes, 'x'))) NOT BETWEEN 1 AND 1000 THEN
    problems := problems || jsonb_build_object('field', 'pickup.accessNotes', 'code', 'length');
  END IF;
  IF length(btrim(coalesce(resolved.delivery_access_notes, 'x'))) NOT BETWEEN 1 AND 1000 THEN
    problems := problems || jsonb_build_object('field', 'delivery.accessNotes', 'code', 'length');
  END IF;

  -- A draft may be incomplete, but not empty.
  IF problems = '[]'::jsonb
     AND num_nonnulls(resolved.shipper_reference, resolved.cargo_description, resolved.gross_weight_kg,
                      resolved.pieces, resolved.packaging, resolved.equipment_needed,
                      resolved.pickup_address, resolved.pickup_country, resolved.pickup_access_notes,
                      resolved.pickup_from_local, resolved.pickup_until_local,
                      resolved.delivery_address, resolved.delivery_country, resolved.delivery_access_notes,
                      resolved.delivery_from_local, resolved.delivery_until_local) = 0 THEN
    problems := problems || jsonb_build_object('field', '', 'code', 'empty');
  END IF;
END
$$;

-- What the history keeps of a draft.
CREATE FUNCTION trucker.shipment_values(d trucker.shipment_draft) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT to_jsonb(d) - 'list_position' - 'organisation_id' - 'created_by' - 'created_at' - 'updated_at'
$$;

CREATE FUNCTION trucker.content_hash(p_content jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(sha256(convert_to(p_content::text, 'UTF8')), 'hex')
$$;

-- ---------------------------------------------------------------------------------------------
-- The route check: configured availability, read from the registers at the moment of asking.
-- It is not stored, is not legal clearance and gives no right.
--   status   unknown (a place has no country yet) | open | closed
--   reasons  each part that is not open: origin, destination, lane, transit (with its country)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.route_check(p_origin text, p_destination text, p_allow_fixtures boolean)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  reasons jsonb := '[]'::jsonb;
  the_lane trucker.lane;
  stop record;
BEGIN
  IF p_origin IS NULL OR p_destination IS NULL THEN
    RETURN jsonb_build_object('status', 'unknown', 'basis', 'configuration', 'reasons', reasons);
  END IF;
  IF NOT (trucker.country_available(p_origin, p_allow_fixtures)
          AND EXISTS (SELECT 1 FROM trucker.country c WHERE c.code = p_origin AND c.operating_state = 'enabled')) THEN
    reasons := reasons || jsonb_build_object('part', 'origin', 'code', 'country_closed', 'country', p_origin);
  END IF;
  IF NOT (trucker.country_available(p_destination, p_allow_fixtures)
          AND EXISTS (SELECT 1 FROM trucker.country c WHERE c.code = p_destination AND c.operating_state = 'enabled')) THEN
    reasons := reasons || jsonb_build_object('part', 'destination', 'code', 'country_closed', 'country', p_destination);
  END IF;
  SELECT * INTO the_lane FROM trucker.lane l
  WHERE l.origin_country = p_origin AND l.destination_country = p_destination
    AND trucker.country_available(p_origin, p_allow_fixtures)
    AND trucker.country_available(p_destination, p_allow_fixtures);
  IF NOT FOUND THEN
    reasons := reasons || jsonb_build_object('part', 'lane', 'code', 'lane_missing');
  ELSE
    IF the_lane.state <> 'enabled' THEN
      reasons := reasons || jsonb_build_object('part', 'lane', 'code', 'lane_closed');
    END IF;
    FOR stop IN
      SELECT t.position, t.country_code FROM trucker.lane_transit t
      WHERE t.lane_id = the_lane.id ORDER BY t.position
    LOOP
      IF NOT (trucker.country_available(stop.country_code, p_allow_fixtures)
              AND EXISTS (SELECT 1 FROM trucker.country c
                          WHERE c.code = stop.country_code AND c.operating_state = 'enabled')) THEN
        reasons := reasons || jsonb_build_object(
          'part', 'transit', 'code', 'country_closed', 'country', stop.country_code, 'position', stop.position);
      END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object(
    'status', CASE WHEN reasons = '[]'::jsonb THEN 'open' ELSE 'closed' END,
    'basis', 'configuration',
    'transit', coalesce((SELECT jsonb_agg(t.country_code ORDER BY t.position)
                         FROM trucker.lane_transit t WHERE t.lane_id = the_lane.id), '[]'::jsonb),
    'reasons', reasons);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Creating a draft. The only way in.
-- status: created | repeated | unauthorized | not_found | invalid | key_conflict | limit
--   repeated      the same request again (same key, same content): the same draft
--   not_found     no organisation selected that the caller administers
--   invalid       detail lists the problems by field
--   limit         detail carries the limit that applied
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.create_shipment_draft(
  p_key text, p_content jsonb, p_allow_fixtures boolean,
  OUT status text, OUT draft_id uuid, OUT detail jsonb
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
  made trucker.shipment_draft;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
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
  -- One creation at a time per organisation, so the limit cannot be raced and the same key
  -- sent twice at once is handled one after the other.
  PERFORM pg_advisory_xact_lock(hashtextextended('shipment.create:' || org::text, 0));
  -- After any wait: still signed in, still an administrator, and what time it is now.
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
    IF earlier.operation <> 'create' OR earlier.request_hash <> hash
       OR NOT EXISTS (SELECT 1 FROM trucker.shipment_draft d
                      WHERE d.id = earlier.draft_id AND d.organisation_id = org) THEN
      status := 'key_conflict';
      RETURN;
    END IF;
    status := 'repeated';
    draft_id := earlier.draft_id;
    RETURN;
  END IF;
  IF FOUND THEN
    DELETE FROM trucker.shipment_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  END IF;

  SELECT * INTO checked FROM trucker.resolve_shipment_content(p_content, p_allow_fixtures);
  IF checked.problems <> '[]'::jsonb THEN
    status := 'invalid';
    detail := checked.problems;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM trucker.shipment_draft d
      WHERE d.organisation_id = org AND d.status = 'draft') >= g.shipment_open_draft_limit THEN
    status := 'limit';
    detail := jsonb_build_object('limit', g.shipment_open_draft_limit);
    RETURN;
  END IF;

  made := checked.resolved;
  INSERT INTO trucker.shipment_draft (
    organisation_id, shipper_reference, cargo_description, gross_weight_kg, pieces, packaging,
    equipment_needed,
    pickup_address, pickup_country, pickup_time_zone, pickup_access_notes,
    pickup_from_local, pickup_from_offset_minutes, pickup_from_at,
    pickup_until_local, pickup_until_offset_minutes, pickup_until_at,
    delivery_address, delivery_country, delivery_time_zone, delivery_access_notes,
    delivery_from_local, delivery_from_offset_minutes, delivery_from_at,
    delivery_until_local, delivery_until_offset_minutes, delivery_until_at,
    created_by, created_at, updated_at)
  VALUES (
    org, made.shipper_reference, made.cargo_description, made.gross_weight_kg, made.pieces, made.packaging,
    made.equipment_needed,
    made.pickup_address, made.pickup_country, made.pickup_time_zone, made.pickup_access_notes,
    made.pickup_from_local, made.pickup_from_offset_minutes, made.pickup_from_at,
    made.pickup_until_local, made.pickup_until_offset_minutes, made.pickup_until_at,
    made.delivery_address, made.delivery_country, made.delivery_time_zone, made.delivery_access_notes,
    made.delivery_from_local, made.delivery_from_offset_minutes, made.delivery_from_at,
    made.delivery_until_local, made.delivery_until_offset_minutes, made.delivery_until_at,
    actor, t, t)
  RETURNING * INTO made;
  INSERT INTO trucker.shipment_retry_key (person_id, key, operation, request_hash, draft_id, resulting_version, created_at)
  VALUES (actor, p_key, 'create', hash, made.id, made.version, t);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES
    (t, actor, org, 'shipment.created', 'shipment_draft', made.id,
     nullif(current_setting('trucker.request_id', true), ''), NULL, trucker.shipment_values(made));
  status := 'created';
  draft_id := made.id;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Changing a draft.
-- status: updated | repeated | unauthorized | not_found | discarded | conflict | invalid
--         | key_conflict
--   repeated   this very request was applied before (same key, same content). Nothing is
--              changed again; `version` is the version it produced then
--   conflict   the draft is no longer at the version the change was made against. Nothing
--              is saved; `version` is the current one
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.update_shipment_draft(
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

-- ---------------------------------------------------------------------------------------------
-- Discarding a draft. The record and its history are kept; nothing is deleted.
-- status: discarded | repeated | already_discarded | unauthorized | not_found | conflict
--         | key_conflict
-- A draft that is already discarded is answered as such whatever version or key is sent, and
-- nothing more is written: one discard, one history entry.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.discard_shipment_draft(
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

-- ---------------------------------------------------------------------------------------------
-- The list: the selected organisation's drafts, newest created first, one page at a time.
--   p_status  draft | discarded | all
--   p_after   the identifier of the last draft of the page before, or NULL for the first page
-- The order is the order of creation, which never changes, so changing or discarding a draft
-- moves nothing: a page read later can neither repeat nor skip a draft that was there when
-- the reading began. The page size is a protected setting. `more` says whether a further page
-- exists. A cursor that is not a draft of this organisation is refused.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.list_shipment_drafts(p_status text, p_after uuid)
RETURNS TABLE (
  id uuid, status text, version integer, shipper_reference text, cargo_description text,
  pickup_country text, delivery_country text, created_at timestamptz, updated_at timestamptz,
  more boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  org uuid := trucker.request_organisation();
  page integer;
  start_before bigint;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('draft', 'discarded', 'all') THEN
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
    SELECT q.id, q.status, q.version, q.shipper_reference, q.cargo_description,
           q.pickup_country, q.delivery_country, q.created_at, q.updated_at,
           count(*) OVER () > page
    FROM (
      SELECT d.* FROM trucker.shipment_draft d
      WHERE d.organisation_id = org
        AND (p_status = 'all' OR d.status = p_status)
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
  trucker.route_check(text, text, boolean),
  trucker.offset_choices(uuid),
  trucker.create_shipment_draft(text, jsonb, boolean),
  trucker.update_shipment_draft(uuid, integer, text, jsonb, boolean),
  trucker.discard_shipment_draft(uuid, integer, text),
  trucker.list_shipment_drafts(text, uuid)
TO trucker_app;
