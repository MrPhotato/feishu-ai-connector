BEGIN;

CREATE TABLE credential_storage_probe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_value varchar(64) NOT NULL
    CHECK (probe_value = 'credential-storage-probe-v1'),
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  )
);

ALTER TABLE credential_storage_probe ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON credential_storage_probe
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "修改全部数据" ON credential_storage_probe
  AS PERMISSIVE FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "查看全部数据" ON credential_storage_probe
  AS PERMISSIVE FOR SELECT TO authenticated, anon
  USING (false);

CREATE POLICY "修改本人数据" ON credential_storage_probe
  AS PERMISSIVE FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

INSERT INTO credential_storage_probe (id, probe_value)
VALUES ('00000000-0000-4000-8000-000000000001', 'credential-storage-probe-v1');

COMMIT;
