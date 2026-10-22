#!/usr/bin/env bash
set -euo pipefail
: "${CORE_DB_PASSWORD:?Missing core password}"
: "${WORKFLOW_DB_PASSWORD:?Missing workflow password}"

psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
\getenv core_password CORE_DB_PASSWORD
\getenv workflow_password WORKFLOW_DB_PASSWORD
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'core_app', :'core_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_app') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'workflow_app', :'workflow_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_app') \gexec
SELECT 'CREATE DATABASE campus_core OWNER core_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'campus_core') \gexec
SELECT 'CREATE DATABASE campus_workflow OWNER workflow_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'campus_workflow') \gexec
REVOKE ALL ON DATABASE campus_core FROM PUBLIC;
REVOKE ALL ON DATABASE campus_workflow FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE campus_core TO core_app;
GRANT CONNECT, TEMPORARY ON DATABASE campus_workflow TO workflow_app;
SQL
