BEGIN;
-- Published metadata is served through the authenticated application API;
-- drafts and full version history are private to platform administrators.
CREATE POLICY iteration_configuration_admin_select ON iteration_configuration
  AS RESTRICTIVE FOR SELECT TO authenticated, anon
  USING ('admin' = ANY(string_to_array(COALESCE(current_setting('app.role_ids', TRUE), ''), ',')));
COMMIT;
