ALTER TABLE portal_project ALTER COLUMN _created_by SET DEFAULT CASE
  WHEN current_setting('app.user_id',true)='' THEN NULL::user_profile
  ELSE concat('(',current_setting('app.user_id',true),')')::user_profile END;
ALTER TABLE portal_project ALTER COLUMN _updated_by SET DEFAULT CASE
  WHEN current_setting('app.user_id',true)='' THEN NULL::user_profile
  ELSE concat('(',current_setting('app.user_id',true),')')::user_profile END;
CREATE INDEX IF NOT EXISTS idx_pull_request_reviewer_pending
  ON pull_request_reviewer(repository,notified_at,notification_claim_expires_at,_created_at);
