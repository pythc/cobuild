-- Match the live project registry's read boundary. All mutations remain behind
-- the existing service executor and its dedicated transport key.
DROP POLICY portal_project_service ON portal_project;
CREATE POLICY service_role_bypass_policy ON portal_project TO service_role USING(true);
CREATE POLICY "修改全部数据" ON portal_project TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "修改本人数据" ON portal_project TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "查看全部数据" ON portal_project FOR SELECT TO authenticated USING(true);
GRANT SELECT ON portal_project TO authenticated;
-- These unused signatures exist only because historical migrations created
-- them in fresh databases. Current code uses fenced reconciliation/event RPCs;
-- production no longer exposes these signatures either.
DROP FUNCTION IF EXISTS pull_request_reviewers_replace(text,integer,jsonb,text,uuid,integer,varchar);
DROP FUNCTION IF EXISTS pull_request_reviewer_notification_result(uuid,boolean,text,uuid,integer,varchar);
