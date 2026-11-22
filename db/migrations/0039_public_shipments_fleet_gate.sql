-- Public shipment cards and fleet eligibility at quotation submission.
CREATE FUNCTION trucker.public_shipments(p_after uuid, p_allow_fixtures boolean)
RETURNS TABLE (id uuid, origin text, destination text, equipment jsonb, deadline timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT d.id, d.pickup_country, d.delivery_country,
         jsonb_build_object('en', e.name_en, 'ar', e.name_ar, 'ur', e.name_ur), d.deadline_at
  FROM trucker.shipment_draft d
  JOIN trucker.equipment_type e ON e.code = d.equipment_type
  WHERE (p_after IS NULL OR d.id > p_after)
    AND d.status = 'published' AND d.deadline_at > trucker.clock_now()
    AND NOT EXISTS (SELECT 1 FROM trucker.shipment_suspension s WHERE s.shipment_id = d.id AND s.ended_at IS NULL)
    AND trucker.organisation_publishable(d.organisation_id)
    AND trucker.route_check(d.pickup_country, d.delivery_country, p_allow_fixtures) ->> 'status' = 'open'
  ORDER BY d.id
  LIMIT 21
$$;
REVOKE ALL ON FUNCTION trucker.public_shipments(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.public_shipments(uuid, boolean) TO trucker_app;

-- A rigid truck carries its own equipment. A tractor needs a matching eligible trailer.
CREATE FUNCTION trucker.quotation_fleet_matches(d trucker.shipment_draft, p_carrier uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trucker.vehicle v
    JOIN trucker.vehicle_category c ON c.code = v.category_code
    WHERE v.organisation_id = p_carrier
      AND v.kind = 'truck' AND v.status = 'active' AND v.ownership = 'verified'
      AND NOT EXISTS (SELECT 1 FROM trucker.fleet_suspension s WHERE s.vehicle_id = v.id AND s.ended_at IS NULL)
      AND (c.requires_trailer OR v.equipment_type = d.equipment_type)
      AND (NOT c.requires_trailer OR EXISTS (
        SELECT 1 FROM trucker.vehicle t
        WHERE t.organisation_id = p_carrier
          AND t.kind = 'trailer' AND t.status = 'active' AND t.ownership = 'verified'
          AND t.equipment_type = d.equipment_type
          AND NOT EXISTS (SELECT 1 FROM trucker.fleet_suspension s WHERE s.vehicle_id = t.id AND s.ended_at IS NULL)
      ))
  )
$$;
REVOKE ALL ON FUNCTION trucker.quotation_fleet_matches(trucker.shipment_draft, uuid) FROM PUBLIC;


CREATE OR REPLACE FUNCTION trucker.submit_quotation(p_shipment uuid, p_key text, p_content jsonb, p_allow_fixtures boolean, OUT status text, OUT quotation_id uuid, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.shipment_draft;
  t trucker.shipment_quotation_terms;
  g trucker.security_setting;
  c record;
  fr record;
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
  IF NOT trucker.quotation_fleet_matches(d, entered.org) THEN
    status := 'fleet_mismatch';
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
  SELECT * INTO fr FROM trucker.quotation_freight(p_content, v_at);
  c.problems := c.problems || fr.problems;
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
     shipment_version, created_at, created_by, freight_methods, freight_due_days)
  VALUES (made.id, 1, 'submitted', c.amount, t.currency_code, c.inclusions,
          c.valid_until_local, c.valid_until_offset_minutes, c.valid_until,
          c.earliest_pickup_local, c.earliest_pickup_offset_minutes, c.earliest_pickup_at, c.notes,
          d.published_version, v_at, entered.actor, fr.methods, fr.due_days);
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
$function$;

CREATE OR REPLACE FUNCTION trucker.quotation_context(p_shipment uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
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
    'fleetMatches', trucker.quotation_fleet_matches(d, entered.org),
    'terms', CASE WHEN t.shipment_id IS NOT NULL AND trucker.quotation_registers_available(p_allow_fixtures)
                  THEN trucker.quotation_terms_values(t) END,
    'pickupWindow', jsonb_build_object('timeZone', d.pickup_time_zone,
                                       'from', to_char(d.pickup_from_local, 'YYYY-MM-DD"T"HH24:MI'),
                                       'until', to_char(d.pickup_until_local, 'YYYY-MM-DD"T"HH24:MI')),
    -- The most days after proof of delivery a carrier may give for the freight.
    'freightMaxDueDays', (trucker.financial_settings_at(trucker.clock_now())).freight_due_days,
    'quotationDeadline', jsonb_build_object('at', d.deadline_at,
                                            'local', to_char(d.deadline_local, 'YYYY-MM-DD"T"HH24:MI'),
                                            'timeZone', d.pickup_time_zone),
    'quotations', coalesce((SELECT jsonb_agg(trucker.quotation_values(q, d, trucker.clock_now(), p_allow_fixtures)
                                             ORDER BY q.created_at DESC, q.id)
                            FROM trucker.quotation q
                            WHERE q.shipment_id = d.id AND q.carrier_organisation_id = entered.org), '[]'::jsonb));
END
$function$;
