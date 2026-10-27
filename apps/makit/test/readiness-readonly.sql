-- Read-only readiness checks. Aggregate counts only; no document, payload or credentials.
SELECT count(*) FILTER (WHERE requirement_id LIKE 'recQaTransaction%' OR actor_user_id LIKE 'qa-operation-%') AS leftover_test_jobs
FROM requirement_update_job;
SELECT count(*) FILTER (WHERE status='failed' AND EXISTS (
  SELECT 1 FROM requirement_update_job correction WHERE correction.status='succeeded'
    AND correction.actor_user_id=j.actor_user_id AND correction.requirement_id=j.requirement_id
    AND correction.input_json::jsonb #>> '{input,recoveryOf}'=j.id::text)) AS explicitly_corrected
FROM requirement_update_job j;
EXPLAIN SELECT candidate.id FROM requirement_operation_outbox candidate
JOIN requirement_update_job current_job ON current_job.id=candidate.operation_id
WHERE candidate.status IN('pending','retry_wait')
AND candidate.available_at<=CURRENT_TIMESTAMP AND candidate.attempts<8
AND (candidate.consumer<>'notification' OR NOT EXISTS (
  SELECT 1 FROM requirement_operation_outbox previous
  JOIN requirement_update_job previous_job ON previous_job.id=previous.operation_id
  WHERE previous.consumer='notification' AND previous.status<>'succeeded'
    AND previous_job.requirement_id=current_job.requirement_id
    AND previous_job.operation_sequence<current_job.operation_sequence))
ORDER BY current_job.operation_sequence,candidate.id LIMIT 8 FOR UPDATE OF candidate SKIP LOCKED;
