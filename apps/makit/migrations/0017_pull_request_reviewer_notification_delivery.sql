BEGIN;

-- Superseded by additive migration 0021. This migration intentionally keeps
-- the legacy reviewer contract unchanged. Environments that applied an early
-- draft are repaired by 0019 before the new outbox is introduced.

COMMIT;
