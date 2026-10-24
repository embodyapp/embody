-- Disposable verification fixture only. Never run against customer databases.
-- Public test passwords are intentionally not production credentials.
CREATE ROLE embody_migrator LOGIN PASSWORD 'fixture-only-migrator' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE embody_runtime LOGIN PASSWORD 'fixture-only-runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE embody_other LOGIN PASSWORD 'fixture-only-other' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE embody_platform_migrator LOGIN PASSWORD 'fixture-only-platform-migrator' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE embody_platform_runtime LOGIN PASSWORD 'fixture-only-platform-runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- M13 app provisioner: creates per-app databases and roles; no superuser, no BYPASSRLS, no data access of its own.
CREATE ROLE embody_provisioner LOGIN PASSWORD 'fixture-only-provisioner' NOSUPERUSER CREATEDB CREATEROLE NOINHERIT NOBYPASSRLS;
CREATE DATABASE embody_platform OWNER embody_platform_migrator;
REVOKE ALL ON DATABASE embody_platform FROM PUBLIC;
GRANT CONNECT ON DATABASE embody_platform TO embody_platform_runtime;
CREATE DATABASE embody_test OWNER embody_migrator;
CREATE DATABASE embody_other OWNER embody_other;
REVOKE ALL ON DATABASE embody_test FROM PUBLIC;
REVOKE ALL ON DATABASE embody_other FROM PUBLIC;
GRANT CONNECT ON DATABASE embody_test TO embody_runtime;
\connect embody_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO embody_migrator;
GRANT USAGE ON SCHEMA public TO embody_runtime;
\connect embody_other
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO embody_other;
\connect embody_platform
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO embody_platform_migrator;
GRANT USAGE ON SCHEMA public TO embody_platform_runtime;
