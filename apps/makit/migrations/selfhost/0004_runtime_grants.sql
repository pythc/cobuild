DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'makit_application') THEN
    CREATE ROLE makit_application LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $roles$;
-- This live table was created through the platform schema editor and has no
-- historical SQL migration in the repository. Preserve its observed schema.
CREATE TABLE portal_project (
  id uuid PRIMARY KEY,
  name varchar(80) NOT NULL,
  summary text NOT NULL,
  source_url varchar(300) NOT NULL,
  snapshot_json text,
  source_revision integer NOT NULL DEFAULT 0,
  source_digest varchar(64),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile
);
ALTER TABLE portal_project ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_project_service ON portal_project TO service_role USING (true) WITH CHECK (true);
GRANT service_role_public, authenticated_public, anon_public TO makit_application;
GRANT USAGE ON SCHEMA public TO service_role, authenticated, anon, makit_application;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
-- Legacy business tables keep their original RLS policies. This grants SQL
-- privileges only; the service-only restrictive policies remain effective.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  requirement_update_job, mcp_personal_credential, pull_request_snapshot,
  pull_request_reviewer, github_reviewer_binding, requirement_archive,
  pull_request_reviewer_operation, pull_request_reviewer_state,
  pull_request_reviewer_notification_event, pull_request_refresh_lease,
  requirement_artifact, requirement_ai_review, iteration_configuration,
  portal_project, workspace_saved_view, requirement_update_batch,
  requirement_operation_outbox, requirement_business_event,
  requirement_cache_revision, requirement_ai_review_execution,
  operations_setting, operations_scanner_heartbeat, operations_dependency_sample,
  operations_alert_incident, notification_retry_preview, notification_delivery_attempt,
  notification_delivery, github_webhook_delivery, github_sync_request, github_resource_cache
  TO authenticated, anon;
GRANT SELECT ON makit_collection, makit_record, makit_directory, makit_audit_principal,
  makit_user, makit_user_role TO makit_application;
GRANT INSERT, UPDATE, DELETE ON makit_collection, makit_record, makit_directory,
  makit_user, makit_user_role, makit_session, makit_auth_flow TO makit_application;
GRANT SELECT ON makit_session, makit_auth_flow TO makit_application;
GRANT USAGE, SELECT ON SEQUENCE makit_record_ordinal_seq TO makit_application;
-- New identities use a distinct range; preserve existing numeric legacy IDs.
CREATE SEQUENCE makit_user_id_seq AS bigint START WITH 8000000000000000000;
GRANT USAGE, SELECT ON SEQUENCE makit_user_id_seq TO makit_application;
