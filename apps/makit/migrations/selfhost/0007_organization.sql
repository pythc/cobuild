ALTER TABLE makit_directory ADD COLUMN department_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(department_ids)='array');
ALTER TABLE makit_user_role ADD COLUMN source text NOT NULL DEFAULT 'native' CHECK(source IN ('legacy','native'));
CREATE TABLE makit_department (id text PRIMARY KEY, name text NOT NULL, parent_id text NOT NULL DEFAULT '0');
CREATE TABLE makit_access_policy (id boolean PRIMARY KEY DEFAULT true CHECK(id), scope text NOT NULL CHECK(scope IN ('Tenant','Range')),
  users jsonb NOT NULL DEFAULT '[]', departments jsonb NOT NULL DEFAULT '[]', chats jsonb NOT NULL DEFAULT '[]', imported_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE makit_role_binding (role_id text NOT NULL CHECK(role_id IN ('admin','editor','viewer','operations_super_admin','operations_viewer')),
  kind text NOT NULL CHECK(kind IN ('user','department','chat')), external_id text NOT NULL, PRIMARY KEY(role_id,kind,external_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON makit_department,makit_access_policy,makit_role_binding TO makit_application;
