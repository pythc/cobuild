-- Monitoring retirement fence. Old cloud instances may outlive a release.
-- Discard only telemetry writes without aborting their business transactions.
-- DELETE remains available for the separately authorized historical cleanup.
-- Rollback: drop these three triggers; no business table or permission changes.
CREATE OR REPLACE FUNCTION operations_discard_retired_telemetry_v1()
RETURNS trigger LANGUAGE plpgsql AS $retired$
BEGIN
  IF TG_TABLE_NAME NOT IN (
    'operations_scanner_heartbeat',
    'operations_dependency_sample',
    'operations_alert_incident'
  ) THEN
    RAISE EXCEPTION 'retirement fence attached to unexpected table';
  END IF;
  RETURN NULL;
END;
$retired$;

CREATE OR REPLACE TRIGGER operations_retired_telemetry_fence
BEFORE INSERT OR UPDATE ON operations_scanner_heartbeat
FOR EACH ROW EXECUTE FUNCTION operations_discard_retired_telemetry_v1();

CREATE OR REPLACE TRIGGER operations_retired_telemetry_fence
BEFORE INSERT OR UPDATE ON operations_dependency_sample
FOR EACH ROW EXECUTE FUNCTION operations_discard_retired_telemetry_v1();

CREATE OR REPLACE TRIGGER operations_retired_telemetry_fence
BEFORE INSERT OR UPDATE ON operations_alert_incident
FOR EACH ROW EXECUTE FUNCTION operations_discard_retired_telemetry_v1();
