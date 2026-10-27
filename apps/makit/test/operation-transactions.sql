-- Development only. All synthetic rows stay inside this transaction and are
-- rolled back, invisible to other workers. No Feishu or messaging requests.
BEGIN;
DO $$
DECLARE first_job jsonb; repeat_job jsonb; second_job jsonb; third_job jsonb; jid uuid; second_id uuid; mismatch boolean:=false; confirmed boolean; result jsonb;
BEGIN
 EXECUTE format('SET LOCAL ROLE %I','service_role_'||current_schema());
 first_job:=requirement_update_job_enqueue_v2('recQaTransaction001','{"patch":{"priority":"P1"}}'::jsonb,'qa_transaction_actor','隔离测试','qa_mutation_001',repeat('a',64),'web');
 jid:=(first_job->>'id')::uuid;
 IF first_job->>'operation_sequence' IS NULL OR (first_job->>'operation_sequence')::bigint<=0 THEN RAISE EXCEPTION 'database sequence missing'; END IF;
 repeat_job:=requirement_update_job_enqueue_v2('recQaTransaction001','{"patch":{"priority":"P1"}}'::jsonb,'qa_transaction_actor','隔离测试','qa_mutation_001',repeat('a',64),'web');
 IF first_job->>'id'<>repeat_job->>'id' THEN RAISE EXCEPTION 'idempotency failed'; END IF;
 BEGIN PERFORM requirement_update_job_enqueue_v2('recQaTransaction001','{"patch":{"priority":"P2"}}'::jsonb,'qa_transaction_actor','隔离测试','qa_mutation_001',repeat('b',64),'web'); EXCEPTION WHEN SQLSTATE '22023' THEN mismatch:=true; END;
 IF NOT mismatch THEN RAISE EXCEPTION 'different input accepted'; END IF;
 IF requirement_update_job_claim(jid,'old-token',CURRENT_TIMESTAMP+interval '1 minute') IS NOT NULL THEN RAISE EXCEPTION 'old pod claimed v2'; END IF;
 IF requirement_update_job_claim_v2(jid,'qa-first-token') IS NULL THEN RAISE EXCEPTION 'first claim failed'; END IF;
 IF requirement_update_job_claim_v2(jid,'qa-other-token') IS NOT NULL THEN RAISE EXCEPTION 'duplicate claim'; END IF;
 second_job:=requirement_update_job_enqueue_v2('recQaTransaction001','{"patch":{"priority":"P2"}}'::jsonb,'qa_other_actor','隔离测试','qa_mutation_002',repeat('c',64),'mcp');
 second_id:=(second_job->>'id')::uuid;
 IF (second_job->>'operation_sequence')::bigint<=(first_job->>'operation_sequence')::bigint THEN RAISE EXCEPTION 'operation sequence not increasing'; END IF;
 IF requirement_update_job_claim_v2(second_id,'qa-second-token') IS NOT NULL THEN RAISE EXCEPTION 'parallel write allowed'; END IF;
 IF NOT requirement_update_job_before_write(jid,'qa-first-token','{}','{}','1') THEN RAISE EXCEPTION 'intent fence failed'; END IF;
 UPDATE requirement_update_job SET lock_expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE id=jid;
 IF requirement_update_job_claim_v2(second_id,'qa-second-token') IS NOT NULL THEN RAISE EXCEPTION 'uncertain write replayed'; END IF;
 IF (SELECT status FROM requirement_update_job WHERE id=jid)<>'unknown' THEN RAISE EXCEPTION 'lost receipt not unknown'; END IF;
 third_job:=requirement_update_job_enqueue_v2('recQaTransactionOther','{"patch":{"priority":"P1"}}'::jsonb,'qa_third_actor','隔离测试','qa_mutation_003',repeat('d',64),'web');
 IF NOT EXISTS(SELECT 1 FROM requirement_update_job_pending_ids_v2(100) WHERE id=(third_job->>'id')::uuid) THEN RAISE EXCEPTION 'blocked requirement starved another'; END IF;
 UPDATE requirement_update_job SET execution_stage='reviewed_unknown' WHERE id=jid;
 IF requirement_update_job_claim_v2(second_id,'qa-second-token') IS NULL THEN RAISE EXCEPTION 'manual unblock failed'; END IF;
 IF NOT requirement_update_job_before_write(second_id,'qa-second-token','{}','{}','1') THEN RAISE EXCEPTION 'second intent failed'; END IF;
 result:=jsonb_build_object('requirementId','recQaTransaction001','actorUserId','qa_other_actor','kind','edit','occurredAt',CURRENT_TIMESTAMP,'beforeJson','{}','afterJson','{}','fieldsJson','["优先级"]');
 confirmed:=requirement_update_job_confirm(second_id,'qa-second-token','{}','{}',result,'{"success":true}');
 IF NOT confirmed THEN RAISE EXCEPTION 'commit confirmation failed'; END IF;
 IF NOT requirement_update_job_confirm(second_id,'qa-second-token','{}','{}',result,'{"success":true}') THEN RAISE EXCEPTION 'confirmation is not idempotent'; END IF;
 IF (SELECT count(*) FROM requirement_business_event WHERE operation_id=second_id)<>1 OR (SELECT count(*) FROM requirement_operation_outbox WHERE operation_id=second_id)<>4 THEN RAISE EXCEPTION 'event outbox not atomic/deduplicated'; END IF;
 IF requirement_update_job_uncertain(second_id,'qa-second-token') THEN RAISE EXCEPTION 'confirmed outcome regressed'; END IF;
 -- Roll back within this statement as well: CLI gateways may reset roles or
 -- transaction wrappers between statements.
 RAISE EXCEPTION 'transactional assertions passed' USING ERRCODE='ZX001';
EXCEPTION WHEN SQLSTATE 'ZX001' THEN RAISE NOTICE 'all transactional assertions passed; synthetic rows rolled back';
END; $$;
SELECT 'all transactional assertions passed; rolling back' AS result;
ROLLBACK;
