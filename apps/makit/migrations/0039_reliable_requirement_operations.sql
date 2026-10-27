BEGIN;
-- V2 admission is service-only. Actor identity must come from the freshly
-- verified web/MCP identity, never from a client-supplied actor field.
CREATE OR REPLACE FUNCTION requirement_update_job_enqueue_v2(
 p_requirement_id varchar,p_input jsonb,p_actor_user_id varchar,
 p_actor_name varchar,p_mutation_id varchar,p_hash varchar,p_source varchar)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE j requirement_update_job%ROWTYPE;
BEGIN
 IF current_setting('role',TRUE) !~ '^service_role(_|$)' THEN RAISE insufficient_privilege; END IF;
 IF p_requirement_id !~ '^rec[a-zA-Z0-9]+$' OR NULLIF(p_actor_user_id,'') IS NULL
  OR p_mutation_id !~ '^[a-zA-Z0-9_-]{8,128}$' OR p_hash !~ '^[a-f0-9]{64}$'
  OR p_source NOT IN ('web','mcp','bulk') OR jsonb_typeof(p_input) <> 'object'
  OR octet_length(p_input::text)>262144 THEN
  RAISE EXCEPTION 'invalid operation input' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('requirement_mutation:'||p_requirement_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('requirement_update_job:'||p_actor_user_id,0));
 SELECT * INTO j FROM requirement_update_job WHERE actor_user_id=p_actor_user_id AND client_mutation_id=p_mutation_id;
 IF FOUND THEN
  IF j.request_hash<>p_hash OR j.requirement_id<>p_requirement_id THEN
   RAISE EXCEPTION 'idempotency key input mismatch' USING ERRCODE='22023';
  END IF;
  RETURN to_jsonb(j);
 END IF;
 IF EXISTS(SELECT 1 FROM requirement_archive WHERE requirement_id=p_requirement_id AND restored_at IS NULL AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'requirement is archived' USING ERRCODE='55000'; END IF;
 IF (SELECT count(*) FROM requirement_update_job WHERE actor_user_id=p_actor_user_id AND status IN('queued','running','unknown'))>=50
 THEN RAISE EXCEPTION 'too many active requirement update jobs' USING ERRCODE='54000'; END IF;
 INSERT INTO requirement_update_job(requirement_id,expected_updated_at,input_json,actor_user_id,actor_user_name,
  client_mutation_id,request_hash,source,execution_stage,trace_id)
 VALUES(p_requirement_id,p_input->>'expectedUpdatedAt',jsonb_build_object('input',p_input)::text,
  p_actor_user_id,p_actor_name,p_mutation_id,p_hash,p_source,'accepted',gen_random_uuid()::text)
 RETURNING * INTO j;
 RETURN to_jsonb(j);
END;
$$;

CREATE OR REPLACE FUNCTION requirement_update_job_claim_v2(p_id uuid,p_token varchar)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE j requirement_update_job%ROWTYPE;
BEGIN
 IF current_setting('role',TRUE) !~ '^service_role(_|$)' THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO j FROM requirement_update_job WHERE id=p_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('requirement_mutation:'||j.requirement_id,0));
 -- An expired in-flight external write is not evidence of rejection.
 UPDATE requirement_update_job SET status='unknown',execution_stage='reconcile',error_code='WRITE_OUTCOME_UNKNOWN',
  error_message='写入结果待核实，请查看最新值；为避免覆盖或重复通知，未自动重试',
  lock_token=NULL,lock_expires_at=NULL,_updated_at=CURRENT_TIMESTAMP
 WHERE requirement_id=j.requirement_id AND status='running' AND lock_expires_at<=CURRENT_TIMESTAMP
  AND (execution_stage='writing' OR execution_stage IS NULL);
 IF EXISTS(SELECT 1 FROM requirement_update_job b WHERE b.requirement_id=j.requirement_id
  AND b.id<>p_id AND (b.status='unknown' OR b.status='running' OR (b.status='queued' AND (b._created_at,b.id)<(j._created_at,j.id))))
 THEN RETURN NULL; END IF;
 UPDATE requirement_update_job SET status='running',execution_stage='validating',
  lock_token=p_token,lock_expires_at=CURRENT_TIMESTAMP+interval '15 minutes',
  started_at=CURRENT_TIMESTAMP,attempts=attempts+1,_updated_at=CURRENT_TIMESTAMP
 WHERE id=p_id AND ((status='queued' AND available_at<=CURRENT_TIMESTAMP)
  OR (status='running' AND lock_expires_at<=CURRENT_TIMESTAMP AND execution_stage<>'writing'))
 RETURNING * INTO j;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN to_jsonb(j);
END;
$$;

-- Old pods may drain old jobs, but must never consume new v2 operations.
CREATE OR REPLACE FUNCTION requirement_update_job_claim(p_job_id uuid,p_lock_token varchar,p_lock_expires_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE payload jsonb;
BEGIN
 IF current_setting('role',TRUE) !~ '^service_role(_|$)' THEN RAISE insufficient_privilege; END IF;
 IF EXISTS(SELECT 1 FROM requirement_update_job WHERE id=p_job_id AND client_mutation_id IS NOT NULL) THEN RETURN NULL; END IF;
 payload := requirement_update_job_claim_v2(p_job_id,p_lock_token);
 IF payload IS NOT NULL THEN
  UPDATE requirement_update_job SET execution_stage='writing' WHERE id=p_job_id AND lock_token=p_lock_token;
 END IF;
 RETURN payload;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_update_job_before_write(p_id uuid,p_token varchar,p_before text,p_target text,p_workflow varchar)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE n integer;
BEGIN
 IF current_setting('role',TRUE) !~ '^service_role(_|$)' THEN RAISE insufficient_privilege; END IF;
 IF octet_length(p_before)>1000000 OR octet_length(p_target)>1000000 THEN RAISE EXCEPTION 'snapshot too large'; END IF;
 UPDATE requirement_update_job SET execution_stage='writing',before_json=p_before,after_json=p_target,
  workflow_version=p_workflow,_updated_at=CURRENT_TIMESTAMP
 WHERE id=p_id AND status='running' AND lock_token=p_token AND lock_expires_at>CURRENT_TIMESTAMP
  AND execution_stage='validating';
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n=1;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_update_job_confirm(p_id uuid,p_token varchar,p_after text,p_receipt text,p_event jsonb,p_result text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE j requirement_update_job%ROWTYPE; e uuid;
BEGIN
 IF current_setting('role',TRUE) !~ '^service_role(_|$)' THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO j FROM requirement_update_job WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF j.status='succeeded' AND EXISTS(SELECT 1 FROM requirement_business_event WHERE operation_id=p_id) THEN RETURN true; END IF;
 IF j.status<>'running' OR j.lock_token<>p_token OR j.lock_expires_at<=CURRENT_TIMESTAMP OR j.execution_stage<>'writing'
 THEN RETURN false; END IF;
 IF p_event->>'requirementId'<>j.requirement_id OR p_event->>'actorUserId'<>j.actor_user_id
 THEN RAISE EXCEPTION 'operation evidence mismatch'; END IF;
 INSERT INTO requirement_business_event(event_key,operation_id,requirement_id,actor_user_id,actor_name,kind,
  workflow_version,occurred_at,before_json,after_json,fields_json,request_id)
 VALUES('operation:'||p_id,p_id,j.requirement_id,j.actor_user_id,j.actor_user_name,p_event->>'kind',
  j.workflow_version,(p_event->>'occurredAt')::timestamptz,p_event->>'beforeJson',
  p_event->>'afterJson',p_event->>'fieldsJson',p_event->>'requestId')
 RETURNING id INTO e;
 INSERT INTO requirement_operation_outbox(event_id,operation_id,consumer)
 SELECT e,p_id,unnest(ARRAY['history','review','notification','cache']::text[]);
 UPDATE requirement_update_job SET status='succeeded',execution_stage='confirmed',
  after_json=p_after,remote_receipt_json=p_receipt,result_json=p_result,
  finished_at=CURRENT_TIMESTAMP,lock_token=NULL,lock_expires_at=NULL,_updated_at=CURRENT_TIMESTAMP WHERE id=p_id;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_update_job_uncertain(p_id uuid,p_token varchar)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE n integer;
BEGIN
 IF current_setting('role',TRUE) !~ '^service_role(_|$)' THEN RAISE insufficient_privilege; END IF;
 UPDATE requirement_update_job SET status='unknown',execution_stage='reconcile',error_code='WRITE_OUTCOME_UNKNOWN',
  error_message='写入结果待核实，请查看最新值；为避免覆盖或重复通知，未自动重试',
  lock_token=NULL,lock_expires_at=NULL,_updated_at=CURRENT_TIMESTAMP
 WHERE id=p_id AND status='running' AND lock_token=p_token AND execution_stage='writing';
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n=1;
END;
$$;

DO $$
DECLARE s text:=current_schema(); signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
 'requirement_update_job_enqueue_v2(varchar,jsonb,varchar,varchar,varchar,varchar,varchar)',
 'requirement_update_job_claim_v2(uuid,varchar)',
 'requirement_update_job_claim(uuid,varchar,timestamp with time zone)',
 'requirement_update_job_before_write(uuid,varchar,text,text,varchar)',
 'requirement_update_job_confirm(uuid,varchar,text,text,jsonb,text)',
 'requirement_update_job_uncertain(uuid,varchar)'
 ] LOOP EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',s,signature,s); END LOOP;
END;
$$;
COMMIT;
