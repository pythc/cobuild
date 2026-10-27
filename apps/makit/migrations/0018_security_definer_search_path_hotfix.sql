BEGIN;

-- Reserved migration number. The finalized SECURITY DEFINER functions set a
-- fixed search_path in their own additive migrations (0019, 0021, 0023, 0024).

COMMIT;
