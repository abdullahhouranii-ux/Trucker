-- Private photos for shipment and vehicle records. Sharing is a separate explicit permission.
CREATE TABLE trucker.record_photo (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES trucker.organisation(id),
  shipment_id uuid REFERENCES trucker.shipment_draft(id),
  vehicle_id uuid REFERENCES trucker.vehicle(id),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
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
