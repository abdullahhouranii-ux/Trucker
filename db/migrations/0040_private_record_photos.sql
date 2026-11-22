-- Private photos for shipment and vehicle records. Sharing is a separate explicit permission.
CREATE TABLE trucker.record_photo (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES trucker.organisation(id),
  shipment_id uuid REFERENCES trucker.shipment_draft(id),
  vehicle_id uuid REFERENCES trucker.vehicle(id),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png')),
  -- At most 5 MB a photo (decided by Abdullah, 22 November 2026).
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  storage_key uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  CHECK (num_nonnulls(shipment_id, vehicle_id) = 1)
);
ALTER TABLE trucker.record_photo ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.record_photo FROM PUBLIC,trucker_app;
CREATE INDEX ON trucker.record_photo (shipment_id, created_at, id) WHERE shipment_id IS NOT NULL;
CREATE INDEX ON trucker.record_photo (vehicle_id, created_at, id) WHERE vehicle_id IS NOT NULL;

DO $$
DECLARE previous text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT previous
    FROM pg_constraint
    WHERE conrelid = 'trucker.audit_entry'::regclass AND conname = 'audit_entry_action_check';
  ALTER TABLE trucker.audit_entry DROP CONSTRAINT audit_entry_action_check;
  EXECUTE format('ALTER TABLE trucker.audit_entry ADD CONSTRAINT audit_entry_action_check CHECK ((%s) OR action = %L)',
    previous, 'record_photo.uploaded');
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT previous
    FROM pg_constraint
    WHERE conrelid = 'trucker.audit_entry'::regclass AND conname = 'audit_entry_action_check';
  ALTER TABLE trucker.audit_entry DROP CONSTRAINT audit_entry_action_check;
  EXECUTE format('ALTER TABLE trucker.audit_entry ADD CONSTRAINT audit_entry_action_check CHECK ((%s) OR action = %L)',
    previous, 'record_photo.removed_by_retention');
  -- Removal by the keeping time is done by nobody: its entry carries no actor.
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT previous
    FROM pg_constraint
    WHERE conrelid = 'trucker.audit_entry'::regclass AND conname = 'audit_entry_one_actor';
  ALTER TABLE trucker.audit_entry DROP CONSTRAINT audit_entry_one_actor;
  EXECUTE format('ALTER TABLE trucker.audit_entry ADD CONSTRAINT audit_entry_one_actor CHECK ((%s) OR (actor_person_id IS NULL AND actor_staff_id IS NULL AND action = %L))',
    previous, 'record_photo.removed_by_retention');
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT previous
    FROM pg_constraint
    WHERE conrelid = 'trucker.audit_entry'::regclass AND conname = 'audit_entry_record_type_check';
  ALTER TABLE trucker.audit_entry DROP CONSTRAINT audit_entry_record_type_check;
  EXECUTE format('ALTER TABLE trucker.audit_entry ADD CONSTRAINT audit_entry_record_type_check CHECK ((%s) OR record_type = %L)',
    previous, 'record_photo');
END
$$;

CREATE FUNCTION trucker.record_photos(p_kind text, p_record uuid, p_photo uuid, p_upload jsonb,
  OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog,trucker,pg_temp AS $$
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  parent_state text;
  old trucker.record_photo;
  total integer;
BEGIN
  IF actor IS NULL THEN status := 'unauthorized'; RETURN; END IF;
  IF org IS NULL OR NOT trucker.is_admin(org) THEN status := 'not_found'; RETURN; END IF;
  IF p_kind = 'shipments' THEN
    SELECT d.status INTO parent_state FROM trucker.shipment_draft d
    WHERE d.id = p_record AND d.organisation_id = org FOR UPDATE;
  ELSIF p_kind = 'vehicles' THEN
    SELECT v.status INTO parent_state FROM trucker.vehicle v
    WHERE v.id = p_record AND v.organisation_id = org FOR UPDATE;
  END IF;
  IF parent_state IS NULL THEN status := 'not_found'; RETURN; END IF;

  IF p_photo IS NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'mediaType', f.media_type,
           'size', f.byte_size, 'createdAt', f.created_at) ORDER BY f.created_at, f.id), '[]'::jsonb)
      INTO detail FROM trucker.record_photo f
      WHERE f.organisation_id = org AND
        ((p_kind = 'shipments' AND f.shipment_id = p_record) OR (p_kind = 'vehicles' AND f.vehicle_id = p_record));
    status := 'ok'; RETURN;
  END IF;
  SELECT * INTO old FROM trucker.record_photo f WHERE f.id = p_photo AND f.organisation_id = org
    AND ((p_kind = 'shipments' AND f.shipment_id = p_record) OR (p_kind = 'vehicles' AND f.vehicle_id = p_record));
  IF FOUND THEN
    IF p_upload IS NULL THEN
      status := 'ok';
      detail := jsonb_build_object('storageKey', old.storage_key, 'mediaType', old.media_type, 'fingerprint', old.fingerprint);
    ELSE
      status := CASE WHEN old.fingerprint = p_upload->>'fingerprint'
        AND old.media_type = p_upload->>'mediaType' THEN 'repeated' ELSE 'conflict' END;
    END IF;
    RETURN;
  END IF;
  IF p_upload IS NULL THEN status := 'not_found'; RETURN; END IF;
  IF parent_state NOT IN ('draft', 'published', 'active') THEN status := 'conflict'; RETURN; END IF;
  SELECT count(*) INTO total FROM trucker.record_photo f
    WHERE (p_kind = 'shipments' AND f.shipment_id = p_record) OR (p_kind = 'vehicles' AND f.vehicle_id = p_record);
  IF total >= 12 THEN status := 'limit'; RETURN; END IF;
  INSERT INTO trucker.record_photo (id, organisation_id, shipment_id, vehicle_id, media_type, byte_size, fingerprint, storage_key, created_at)
    VALUES (p_photo, org, CASE WHEN p_kind = 'shipments' THEN p_record END,
      CASE WHEN p_kind = 'vehicles' THEN p_record END,
      p_upload->>'mediaType', (p_upload->>'size')::integer, p_upload->>'fingerprint',
      (p_upload->>'storageKey')::uuid, trucker.clock_now())
    ON CONFLICT (id) DO NOTHING;
  IF NOT FOUND THEN status := 'conflict'; RETURN; END IF;
  INSERT INTO trucker.audit_entry (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, after_values)
  VALUES (trucker.clock_now(), actor, org, 'record_photo.uploaded', 'record_photo', p_photo,
    nullif(current_setting('trucker.request_id', true), ''), jsonb_build_object('recordId', p_record, 'kind', p_kind));
  status := 'stored';
END
$$;
REVOKE ALL ON FUNCTION trucker.record_photos(text,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.record_photos(text,uuid,uuid,jsonb) TO trucker_app;

-- Record photos are kept in the same file store, under record_photo.storage_key. The sweep of
-- unrecorded files must count those keys too, or it would remove photos after their grace period.
CREATE OR REPLACE FUNCTION trucker.pod_storage_keys_in_use(p_keys jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, trucker, pg_temp
AS $function$
#variable_conflict use_column
DECLARE
  v_keys text[];
BEGIN
  IF p_keys IS NULL OR jsonb_typeof(p_keys) <> 'array' THEN
    RAISE EXCEPTION 'pod_storage_keys_in_use expects an array of keys' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_keys) > 500 THEN
    RAISE EXCEPTION 'pod_storage_keys_in_use takes at most 500 keys' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(k), '{}') INTO v_keys
  FROM jsonb_array_elements_text(p_keys) k
  WHERE k ~ '^[0-9a-f-]{36}$';
  RETURN coalesce((SELECT jsonb_agg(u.k ORDER BY u.k) FROM (
             SELECT i.storage_key AS k FROM trucker.pod_item i WHERE i.storage_key = ANY (v_keys)
             UNION
             SELECT e.command->>'storageKey' FROM trucker.booking_dispute_event e
             WHERE e.kind = 'evidence' AND e.command->>'storageKey' = ANY (v_keys)
             UNION
             SELECT p.storage_key::text FROM trucker.record_photo p
             WHERE p.storage_key::text = ANY (v_keys)) u),
           '[]'::jsonb);
END
$function$;
REVOKE ALL ON FUNCTION trucker.pod_storage_keys_in_use(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.pod_storage_keys_in_use(jsonb) TO trucker_app;

-- How long photos are kept once their record has ended without a booking: a shipment withdrawn,
-- expired or discarded, or a vehicle retired. 0 keeps them (development default). A setting, so
-- that it is changed like the other limits (npm run db:settings), not by a code change.
ALTER TABLE trucker.security_setting
  ADD COLUMN record_photo_retention_days integer NOT NULL DEFAULT 0
    CHECK (record_photo_retention_days BETWEEN 0 AND 3650);

-- Removes the records of photos past their keeping time, at most 200 at a time, and audits each.
-- The files are removed afterwards by the sweep of unrecorded files. A booked shipment's photos
-- are never removed here.
CREATE FUNCTION trucker.record_photo_retention_sweep() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  days integer;
  removed integer := 0;
  p trucker.record_photo;
BEGIN
  SELECT g.record_photo_retention_days INTO days FROM trucker.security_setting g;
  IF days IS NULL OR days = 0 THEN RETURN 0; END IF;
  FOR p IN
    SELECT f.* FROM trucker.record_photo f
    LEFT JOIN trucker.shipment_draft d ON d.id = f.shipment_id
    LEFT JOIN trucker.vehicle v ON v.id = f.vehicle_id
    WHERE coalesce(
            CASE WHEN NOT EXISTS (SELECT 1 FROM trucker.booking b WHERE b.shipment_id = d.id)
                 THEN coalesce(d.withdrawn_at, d.expired_at, d.discarded_at) END,
            v.retired_at)
          <= trucker.clock_now() - make_interval(days => days)
    ORDER BY f.created_at, f.id
    LIMIT 200
    FOR UPDATE OF f SKIP LOCKED
  LOOP
    DELETE FROM trucker.record_photo WHERE id = p.id;
    INSERT INTO trucker.audit_entry (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, after_values)
    VALUES (trucker.clock_now(), NULL, p.organisation_id, 'record_photo.removed_by_retention', 'record_photo', p.id, NULL,
            jsonb_build_object('recordId', coalesce(p.shipment_id, p.vehicle_id), 'days', days));
    removed := removed + 1;
  END LOOP;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION trucker.record_photo_retention_sweep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.record_photo_retention_sweep() TO trucker_app;
