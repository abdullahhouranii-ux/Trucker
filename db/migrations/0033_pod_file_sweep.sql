-- Proof of delivery (slice 18b), follow-up: which stored files are recorded.
--
-- A file is stored before the database records it. When the database's answer is lost (the
-- connection fails after the record was committed but before the API heard so), the API cannot
-- tell whether the file is recorded, so it keeps it. A later sweep asks this function which
-- stored keys are recorded and removes only those that are proven not to be.
--
-- It answers only for the keys it is given, and only whether each is recorded: it lists
-- nothing else and reveals no booking, item or person.

CREATE FUNCTION trucker.pod_storage_keys_in_use(p_keys jsonb)
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
  -- At most 500 keys in one question: the API asks in batches.
  IF jsonb_array_length(p_keys) > 500 THEN
    RAISE EXCEPTION 'pod_storage_keys_in_use takes at most 500 keys' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(k), '{}') INTO v_keys
  FROM jsonb_array_elements_text(p_keys) k
  WHERE k ~ '^[0-9a-f-]{36}$';
  RETURN coalesce((SELECT jsonb_agg(i.storage_key ORDER BY i.storage_key)
                   FROM trucker.pod_item i WHERE i.storage_key = ANY (v_keys)), '[]'::jsonb);
END
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.pod_storage_keys_in_use(jsonb) TO trucker_app;
