-- These two columns exist in the live managed catalog but are missing from
-- historical source migrations. Required before importing reviewer receipts.
ALTER TABLE pull_request_reviewer ADD COLUMN notification_claim_token uuid;
ALTER TABLE pull_request_reviewer ADD COLUMN notification_claim_expires_at timestamptz(3);
