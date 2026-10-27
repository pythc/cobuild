BEGIN;
-- Existing online jobs must survive publication. Miaoda rejects adding a
-- NOT NULL column to a populated table, including identity columns. Use a
-- nullable column with an independent sequence instead; new inserts still
-- receive a database-generated, globally ordered value. No job is deleted.
CREATE SEQUENCE IF NOT EXISTS requirement_operation_sequence_v2;
SELECT setval('requirement_operation_sequence_v2',
  GREATEST(COALESCE((SELECT max(operation_sequence) FROM requirement_update_job),0),0)+1,
  false);
ALTER TABLE requirement_update_job ALTER COLUMN operation_sequence DROP IDENTITY IF EXISTS;
ALTER TABLE requirement_update_job ALTER COLUMN operation_sequence DROP NOT NULL;
ALTER TABLE requirement_update_job ALTER COLUMN operation_sequence SET DEFAULT nextval('requirement_operation_sequence_v2');
-- Sequence privileges are managed by Miaoda, not by application GRANTs.
COMMENT ON COLUMN requirement_update_job.operation_sequence IS '数据库分配的全局操作顺序；兼容历史记录的可空发布字段';
COMMIT;
