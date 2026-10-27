-- A fresh self-hosted organization binds to one explicit CoBuild issuer.
-- Existing user databases require an explicit migration rather than email matching.
CREATE TABLE makit_suite_organization (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  issuer text NOT NULL,
  organization_id text NOT NULL
);
GRANT SELECT,INSERT ON makit_suite_organization TO makit_application;
