-- Development-only, rolled-back permission probes; no business mutations.
BEGIN;
DO $test$
DECLARE s text := current_schema();
BEGIN
  PERFORM set_config('app.user_id', 'permission-test-member', true);
  PERFORM set_config('app.role_ids', 'viewer', true);
  EXECUTE format('SET LOCAL ROLE %I', 'authenticated_' || s);
  IF NOT requirement_archive_caller_has_any_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'signed-in member archive permission rejected';
  END IF;
  IF NOT pull_request_reviewer_actor_authorized('permission-test-member', NULL, NULL, NULL, true) THEN
    RAISE EXCEPTION 'signed-in member reviewer permission rejected';
  END IF;
  IF pull_request_reviewer_actor_authorized('forged-other-member', NULL, NULL, NULL, true) THEN
    RAISE EXCEPTION 'forged actor accepted';
  END IF;
  PERFORM set_config('app.user_id', 'anonymous_user_id', true);
  IF requirement_archive_caller_has_any_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'anonymous placeholder accepted';
  END IF;
  EXECUTE format('SET LOCAL ROLE %I', 'anon_' || s);
  IF requirement_archive_caller_has_any_role(ARRAY['admin']) OR
    pull_request_reviewer_actor_authorized('permission-test-member', NULL, NULL, NULL, true) THEN
    RAISE EXCEPTION 'unauthenticated business write accepted';
  END IF;
  RESET ROLE;
END;
$test$;
ROLLBACK;
