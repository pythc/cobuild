BEGIN;
-- Millisecond columns round CURRENT_TIMESTAMP upward. Truncate admission time
-- so a just-enqueued operation can be claimed in the same transaction.
ALTER TABLE requirement_update_job ALTER COLUMN available_at SET DEFAULT date_trunc('milliseconds',CURRENT_TIMESTAMP);
CREATE OR REPLACE FUNCTION requirement_update_job_confirm(p_id uuid,p_token varchar,p_after text,p_receipt text,p_event jsonb,p_result text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE j requirement_update_job%ROWTYPE; e uuid;
BEGIN
 IF current_setting('role',TRUE) !~ '^service_role(_|$)' THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO j FROM requirement_update_job WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF j.status='succeeded' AND EXISTS(SELECT 1 FROM requirement_business_event WHERE operation_id=p_id) THEN RETURN true; END IF;
 IF j.status<>'running' OR j.lock_token IS DISTINCT FROM p_token OR p_token IS NULL OR j.lock_expires_at IS NULL OR j.lock_expires_at<=CURRENT_TIMESTAMP OR j.execution_stage IS DISTINCT FROM 'writing'
 THEN RETURN false; END IF;
 IF p_event->>'requirementId' IS DISTINCT FROM j.requirement_id OR p_event->>'actorUserId' IS DISTINCT FROM j.actor_user_id
 THEN RAISE EXCEPTION 'operation evidence mismatch'; END IF;
 INSERT INTO requirement_business_event(event_key,operation_id,requirement_id,actor_user_id,actor_name,kind,
  workflow_version,occurred_at,before_json,after_json,fields_json,request_id)
 VALUES('operation:'||p_id,p_id,j.requirement_id,j.actor_user_id,j.actor_user_name,p_event->>'kind',
  j.workflow_version,(p_event->>'occurredAt')::timestamptz,p_event->>'beforeJson',
  p_event->>'afterJson',p_event->>'fieldsJson',p_event->>'requestId') RETURNING id INTO e;
 INSERT INTO requirement_operation_outbox(event_id,operation_id,consumer)
 SELECT e,p_id,unnest(ARRAY['history','review','notification','cache']::text[]);
 UPDATE requirement_update_job SET status='succeeded',execution_stage='confirmed',
  after_json=p_after,remote_receipt_json=p_receipt,result_json=p_result,error_code=NULL,error_message=NULL,
  finished_at=CURRENT_TIMESTAMP,lock_token=NULL,lock_expires_at=NULL,_updated_at=CURRENT_TIMESTAMP WHERE id=p_id;
 RETURN true;
END;
$$;
DO $$ DECLARE s text:=current_schema(); BEGIN
EXECUTE format('ALTER FUNCTION %I.requirement_update_job_confirm(uuid,varchar,text,text,jsonb,text) SET search_path=pg_catalog,%I,pg_temp',s,s);
END; $$;
COMMIT;
