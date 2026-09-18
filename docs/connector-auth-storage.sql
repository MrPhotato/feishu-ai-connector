-- Execute once through the supported platform database workflow in dev.
-- This table must contain only synthetic records until gateway/RLS isolation passes.
BEGIN;

CREATE TABLE connector_auth_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model varchar(80) NOT NULL,
  key_hash varchar(64) NOT NULL,
  uid_hash varchar(64),
  grant_hash varchar(64),
  payload_ciphertext text NOT NULL,
  expires_at TIMESTAMP(3) WITH TIME ZONE NOT NULL,
  consumed_at TIMESTAMP(3) WITH TIME ZONE,
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
  ),
  CONSTRAINT connector_auth_record_model_key_unique UNIQUE (model, key_hash),
  CONSTRAINT connector_auth_record_key_hash_format CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT connector_auth_record_uid_hash_format CHECK (uid_hash IS NULL OR uid_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT connector_auth_record_grant_hash_format CHECK (grant_hash IS NULL OR grant_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE connector_auth_record ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy ON connector_auth_record
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "修改全部数据" ON connector_auth_record
  AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "查看全部数据" ON connector_auth_record
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (false);
CREATE POLICY "修改本人数据" ON connector_auth_record
  AS PERMISSIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE INDEX connector_auth_record_model_uid_idx ON connector_auth_record (model, uid_hash);
CREATE INDEX connector_auth_record_grant_idx ON connector_auth_record (grant_hash);
CREATE INDEX connector_auth_record_expiry_idx ON connector_auth_record (expires_at);

COMMIT;
